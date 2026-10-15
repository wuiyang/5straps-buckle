import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { z, ZodError } from 'zod'
import { WorkspacePolicySchema, allowedInterpreters, destructivePatterns, emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore, StateFileError } from '../../adapters/json-file-store.js'
import { rekeyGrants } from '../../adapters/grant-store/file-grant-store.js'
import { rekeySwitch, switchIsOn } from '../../adapters/policy-store/file-dangerously-allow-store.js'
import { readStoredPolicy } from '../../adapters/policy-store/file-policy-store.js'
import { mergePolicies } from '../../domain/policy.js'
import { dangerouslyAllowPath, environmentWorkspaceKeys, grantsPath, legacyWorkspaceRoot, NODE_FOLDER_WORKSPACE, policyPath, type NodeConfig } from '../../runtime/config.js'
import { tokenDigest } from '../access/tokens.js'
import { registryPath, WorkspaceRegistryError, type StoredWorkspace } from './registry.js'
import { overlaps } from './workspace-dirs.js'
import { openSettingsFile, settingsFromEnvironment, settingsPath, WORKSPACE_MOUNT_TARGET, type WorkspaceSettings } from './workspace-settings.js'

/** The id migration gives BUCKLE_AUTH_TOKEN among workspace default's tokens, as the node reported it before. */
export const NODE_TOKEN_ID = 'node'

/** Where migration keeps version 1 of workspaces.json, so an owner going back to an older Buckle can restore it. */
export const REGISTRY_BACKUP = 'workspaces.v1.json'

const V1WorkspaceSchema = z.object({
  id: z.string(), name: z.string(), root: z.string(), adminToken: z.string(),
  tokens: z.array(z.object({ id: z.string(), token: z.string(), label: z.string().default(''), createdAt: z.string() })).min(1),
  policy: WorkspacePolicySchema.default(emptyWorkspacePolicy),
  enabled: z.boolean(), retiredAt: z.string().nullable().default(null), updatedAt: z.string().nullable().default(null),
})
const V1RegistrySchema = z.object({ version: z.literal(1), workspaces: z.array(V1WorkspaceSchema) })
/** Any version, read under the registry's own lock so no other process migrates or registers meanwhile. */
const AnyRegistrySchema = z.object({ version: z.number().int(), workspaces: z.array(z.unknown()) }).passthrough()

/** Migration cannot keep what the node enforced, so it changes nothing and says what the owner has to settle. */
export class MigrationError extends Error {}

interface Planned {
  record: StoredWorkspace
  settings: WorkspaceSettings
  /** The workspace's own state directory, whose grants and switch move from its folder to its id. */
  stateDirectory: string
  /** Whether its dangerously-allow switch survives: a registered workspace's needed the node's own on too. */
  keepSwitch: boolean
}

/**
 * Moves a node set up before the workspace model onto it, once, at the first start of a Buckle that has it (the
 * workspace-model brief, item 1, Q14, Q15). workspaces.json becomes version 2: tokens kept as their sha256, each
 * workspace's admin credential dropped (the node's admin token is the one), `retiredAt` read as offline, and the node's
 * own folder stored as workspace `default`, its folder BUCKLE_WORKSPACE_ROOT or the directory this command runs in,
 * its agent token BUCKLE_AUTH_TOKEN. Each workspace gets a workspace.json holding what the node enforced on it: the
 * environment's settings, and its policy (default: the environment's with what `buckle policy` stored; a registered
 * one: its own within the environment's lists, exactly, or the migration refuses). Grants and switches move from the
 * folder to the id. Version 1 is kept in workspaces.v1.json. Returns what the owner is told; nothing when the node is
 * on version 2 already. Throws MigrationError, having changed nothing, where the node's lists cannot be kept exactly,
 * and WorkspaceRegistryError, as a version 2 registry that will not parse does, where version 1 will not.
 */
export async function migrateNode(input: { node: NodeConfig; platform?: NodeJS.Platform }): Promise<string[]> {
  const { node } = input
  const filePath = registryPath(node.stateDirectory)
  if (registryVersion(filePath) === 2) return []
  const store = createJsonFileStore({ filePath, schema: AnyRegistrySchema, fallback: { version: 0, workspaces: [] }, lockDeadlineMs: node.stateLockDeadlineMs })
  try {
    return await store.update(async (raw) => {
      if (raw.version === 2) return []
      if (raw.version !== 0 && raw.version !== 1) throw new MigrationError(`${filePath} is version ${raw.version}, which this Buckle does not read; it was written by another release`)
      const hadRegistry = raw.version === 1
      const registered = hadRegistry ? version1Workspaces(filePath, raw) : []
      const plans = plan({ ...input, platform: input.platform ?? process.platform, registered, hadRegistry })
      if (hadRegistry) copyFileSync(filePath, join(node.stateDirectory, REGISTRY_BACKUP))
      for (const planned of plans) await apply(node, planned)
      raw.version = 2
      raw.workspaces = plans.map(planned => planned.record)
      return notices({ environment: node.legacySettings, plans, hadRegistry })
    })
  } catch (error) {
    if (error instanceof StateFileError) throw new WorkspaceRegistryError(error.message, 409)
    throw error
  }
}

function version1Workspaces(filePath: string, raw: unknown): z.infer<typeof V1WorkspaceSchema>[] {
  const parsed = V1RegistrySchema.safeParse(raw)
  if (parsed.success) return parsed.data.workspaces
  throw new WorkspaceRegistryError(`${filePath} is version 1 but will not read: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}; owner repair is required`, 409)
}

/** The version workspaces.json says it is, read without the lock: 0 where there is none, -1 where it cannot be read. */
function registryVersion(filePath: string): number {
  try {
    const version = (JSON.parse(readFileSync(filePath, 'utf8')) as { version?: unknown }).version
    return typeof version === 'number' ? version : -1
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 0 : -1
  }
}

/**
 * Whether this state directory served a folder before: a version 1 registry, the agent token or root setting of a node
 * set up then, or the policy or grants a command left. A machine with none of these has no workspace until `buckle
 * init` makes one: the directory a first command happens to run in is no workspace of the owner's. The audit log is no
 * evidence, since every node command, `buckle init` among them, writes it before the registry opens.
 */
function servedBefore(node: NodeConfig, hadRegistry: boolean): boolean {
  return hadRegistry || node.authToken !== '' || node.workspaceRootSetting !== undefined
    || [policyPath(node), grantsPath(node)].some(path => existsSync(path))
}

function plan(input: { node: NodeConfig; platform: NodeJS.Platform; registered: z.infer<typeof V1WorkspaceSchema>[]; hadRegistry: boolean }): Planned[] {
  const { node } = input
  if (!servedBefore(node, input.hadRegistry)) return []
  let environment: WorkspaceSettings
  try { environment = settingsFromEnvironment(node.legacySettings) } catch (error) {
    const reason = error instanceof ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : String(error)
    throw new MigrationError(`The node's settings cannot become workspace settings, so Buckle cannot move it to the workspace model: ${reason}. Change them with buckle settings, then start Buckle again.`)
  }
  const now = new Date().toISOString()
  let dir: string
  try { dir = legacyWorkspaceRoot({ node, platform: input.platform }) } catch (error) {
    throw new MigrationError(`The node's own folder cannot become workspace default: ${error instanceof Error ? error.message : String(error)}`)
  }
  const clash = input.registered.find(workspace => overlaps(workspace.root, dir, input.platform))
  if (clash) throw new MigrationError(`The node's own folder would become workspace default at ${dir}, which overlaps workspace ${clash.id} at ${clash.root}. Run this command from the folder buckle serve serves, or set BUCKLE_WORKSPACE_ROOT to it, so the node's folder keeps its place.`)

  // The node's own folder: the environment's policy with what `buckle policy` stored, unioned, as the node merged them.
  const merged = mergePolicies({ ...environment.policy, mount: environment.mounts[0]?.target ?? null }, readStoredPolicy({ filePath: policyPath(node), workspace: dir }))
  const own: Planned = {
    record: { id: NODE_FOLDER_WORKSPACE, name: node.serverName, dir, online: true, revision: 0, updatedAt: now,
      tokens: node.authToken ? [{ id: NODE_TOKEN_ID, sha256: tokenDigest(node.authToken), label: 'BUCKLE_AUTH_TOKEN', createdAt: now }] : [] },
    settings: { ...environment, policy: { ...merged, mount: null }, mounts: merged.mount === null ? [] : [{ kind: 'workspace', target: merged.mount, access: 'write' }] },
    stateDirectory: node.stateDirectory,
    keepSwitch: true,
  }
  const nodeSwitch = switchIsOn(dangerouslyAllowPath(node), dir)
  const conflicts: string[] = []
  const registered = input.registered.map((workspace): Planned => {
    const stateDirectory = join(node.stateDirectory, 'workspaces', workspace.id)
    const stored = readStoredPolicy({ filePath: policyPath({ stateDirectory }), workspace: workspace.root })
    const kept = withinLists(environment.policy, stored ?? workspace.policy)
    if ('conflicts' in kept) conflicts.push(`workspace ${workspace.id}: ${kept.conflicts.join(' and ')}`)
    return {
      record: { id: workspace.id, name: workspace.name, dir: workspace.root, online: workspace.enabled && !workspace.retiredAt, revision: 0, updatedAt: workspace.updatedAt ?? now,
        tokens: workspace.tokens.map(token => ({ id: token.id, sha256: tokenDigest(token.token), label: token.label, createdAt: token.createdAt })) },
      settings: { ...environment, policy: 'policy' in kept ? kept.policy : environment.policy, mounts: [{ kind: 'workspace', target: WORKSPACE_MOUNT_TARGET, access: 'write' }] },
      stateDirectory,
      keepSwitch: nodeSwitch,
    }
  })
  if (conflicts.length > 0) {
    throw new MigrationError(`The node's environment lists are a ceiling over each registered workspace, and that ceiling goes with the workspace model; these cannot be kept as one list: ${conflicts.join('; ')}. Make one list hold the other's entries, or unset the node's list with buckle settings unset, then start Buckle again. Nothing was changed.`)
  }
  return [own, ...registered]
}

/**
 * A registered workspace's policy within the node's environment lists, as one policy that admits exactly what both
 * admitted (Q14): denials and the destructive lists joined, interpreters the two share, and for each allow list the
 * one that is the other's subset; where neither is, there is no one list, and the conflict is named.
 */
function withinLists(ceiling: WorkspacePolicy, own: WorkspacePolicy): { policy: WorkspacePolicy } | { conflicts: string[] } {
  const conflicts: string[] = []
  const narrower = (name: string, top: string[], mine: string[]): string[] => {
    if (top.length === 0) return mine
    if (mine.length === 0 || top.every(entry => mine.includes(entry))) return top
    if (mine.every(entry => top.includes(entry))) return mine
    conflicts.push(`the ${name} lists`)
    return mine
  }
  const policy: WorkspacePolicy = {
    ...own,
    mount: null,
    commands: {
      allow: narrower('command allow', ceiling.commands.allow, own.commands.allow),
      deny: [...new Set([...ceiling.commands.deny, ...own.commands.deny])],
      destructive: [...new Set([...destructivePatterns(ceiling), ...destructivePatterns(own)])],
      allowedInterpreters: allowedInterpreters(own).filter(name => allowedInterpreters(ceiling).includes(name)),
    },
    network: { allow: narrower('approved URL', ceiling.network.allow, own.network.allow) },
  }
  return conflicts.length > 0 ? { conflicts } : { policy }
}

async function apply(node: NodeConfig, planned: Planned): Promise<void> {
  const { record, stateDirectory } = planned
  const lockDeadlineMs = node.stateLockDeadlineMs
  await openSettingsFile({ filePath: settingsPath(node.stateDirectory, record.id), lockDeadlineMs }).migrate(planned.settings)
  await rekeyGrants({ filePath: grantsPath({ stateDirectory }), from: record.dir, to: record.id, lockDeadlineMs })
  await rekeySwitch({ filePath: dangerouslyAllowPath({ stateDirectory }), from: record.dir, to: planned.keepSwitch ? record.id : null, lockDeadlineMs })
}

function notices(input: { environment: Readonly<Record<string, string>>; plans: Planned[]; hadRegistry: boolean }): string[] {
  const own = input.plans.find(planned => planned.record.id === NODE_FOLDER_WORKSPACE)
  if (!own) return []
  const keys = environmentWorkspaceKeys(input.environment)
  return [
    `Buckle moved this node to the workspace model: workspaces.json is version 2${input.hadRegistry ? `, with version 1 kept in ${REGISTRY_BACKUP}` : ''}, and the node's own folder is workspace default at ${own.record.dir}. An older Buckle sharing this state directory now refuses to run programs and to open registered workspaces.`,
    ...(input.plans.length > 1 ? ['Each registered workspace\'s admin credential is retired: the node\'s admin token opens every workspace.'] : []),
    ...(keys.length > 0 ? [`${keys.join(', ')} ${keys.length === 1 ? 'is a workspace setting now: its value was' : 'are workspace settings now: their values were'} copied into each workspace's workspace.json, and Buckle ignores ${keys.length === 1 ? 'it' : 'them'} from here on. Remove ${keys.length === 1 ? 'it' : 'them'} with buckle settings unset.`] : []),
  ]
}
