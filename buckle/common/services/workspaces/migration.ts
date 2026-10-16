import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'pathe'
import { z } from 'zod'
import { WorkspacePolicySchema, allowedInterpreters, emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { editEnvironmentVariable, updateEnvironmentFile } from '../../adapters/environment-file.js'
import { setMode } from '../../adapters/file-modes.js'
import { createJsonFileStore, StateFileError } from '../../adapters/json-file-store.js'
import { grantKeys, rekeyGrants } from '../../adapters/grant-store/file-grant-store.js'
import { clientKeyScopes, rekeyClientKeys } from '../../adapters/keys/file-client-keys.js'
import { rekeySwitch, switchKeys } from '../../adapters/policy-store/file-dangerously-allow-store.js'
import { readStoredPolicies } from '../../adapters/policy-store/file-policy-store.js'
import { workspaceArgument } from '../../domain/approval-instruction.js'
import { comparablePath, ignoresCase, nativePath } from '../../domain/paths.js'
import { actionsPath, clientKeysPath, dangerouslyAllowPath, grantsPath, legacyWorkspaceRoot, policyPath, type MigrationInput, type NodeConfig } from '../../runtime/config.js'
import { NODE_SCOPE } from '../../types/ports/client-keys.js'
import { tokenDigest } from '../access/tokens.js'
import { openRegistry, registryPath, RegistrySchema, sameName, WorkspaceNameSchema, WorkspaceRegistryError, type StoredWorkspace } from './registry.js'
import { exposedRoots, overlaps } from './workspace-dirs.js'
import { workspaceIdFor } from './workspace-id.js'
import { openSettingsFile, settingsPath, withMount, withPolicy, WORKSPACE_MOUNT_TARGET, WorkspaceSettingsSchema, type WorkspaceSettings } from './workspace-settings.js'

/** The id migration gives BUCKLE_AUTH_TOKEN among the node folder's workspace's tokens, as the node reported it before. */
export const NODE_TOKEN_ID = 'node'

/**
 * The copies migration keeps of what it changes, owner-only, so an owner going back to 0.1 moves each over its file
 * (fix brief 1, A3): the registry and policy.json in the state directory, and every grants and switch file it rekeys,
 * beside where 0.1 kept it. Made once: a move run again after a crash keeps the copies made before anything changed.
 */
export const REGISTRY_BACKUP = 'workspaces.v1.json'
export const POLICY_BACKUP = 'policy.v1.json'
const GRANTS_BACKUP = 'grants.v1.json'
const SWITCH_BACKUP = 'dangerously-allow.v1.json'
const CLIENT_KEYS_BACKUP = 'client-keys.v1.json'
/**
 * Written before the move changes anything and taken away once the registry is version 2: a move run again that finds
 * it is finishing one a crash stopped, and one that does not and finds the workspaces' directories is a node that went
 * back to 0.1 and is moving again (fix brief 4, finding 6).
 */
const MOVING_MARKER = 'moving-onto-workspaces'
/** What the node's own folder was in 0.1, which a key enrolled for it names as its scope. */
const V1_NODE_WORKSPACE = 'default'
/** What 0.1 reads as no registry and no stored policy, kept where the node had neither file, so going back is one step for every node. */
const EMPTY_REGISTRY_V1 = '{"version":1,"workspaces":[]}\n'
const EMPTY_POLICY_V1 = '{"version":1,"workspaces":{}}\n'
/**
 * policy.json once the node moved: a version 2 file 0.1 refuses to read, so an older Buckle sharing the state directory
 * refuses to start rather than serve the node's folder with a token or a policy the node has since changed (finding 4).
 */
const PolicyStubSchema = z.object({ version: z.literal(2), note: z.string() }).strict()
const POLICY_STUB = { version: 2 as const, note: 'Each workspace keeps its policy in workspaces/<id>/workspace.json since the workspace model; policy.v1.json holds what this file held, for going back to 0.1.' }

/**
 * The records 0.1 kept for the node's own folder in the state directory itself, which move to the folder's workspace
 * directory (D85, Q15). The node's own audit log, registry, keys, and credentials stay where they are.
 */
const NODE_FOLDER_RECORDS = ['grants.json', 'dangerously-allow.json', 'approvals.json', 'approval-calls', 'approval-nonces.json', 'plugins.json', 'history', 'code-journal', 'isolated-shell', 'browser-sessions', 'workbenches', 'receive-git-hooks']
/** A workspace's audit log and the state beside it, which a move never sets aside: it would hide calls. */
const AUDIT_LOG = /^actions\.jsonl/
/** What stays in a registered workspace's 0.1 directory: the copies for going back, 0.1's own policy file, and lock files. */
const STAYS_BEHIND = /(?:\.v1\.json|\.lock\.sqlite)$|^policy\.json$|^active-work$/

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
  /** Where 0.1 kept the workspace's records: the state directory for the node's folder, `workspaces/<0.1 id>/` for a registered one. */
  oldStateDirectory: string
  /** The workspace's own state directory now, `workspaces/<id>/`, where its records move. */
  stateDirectory: string
  /** The node's own folder, whose records are the named set in the state directory rather than a directory of their own. */
  nodeFolder: boolean
  /** The key its grants file kept its grants under, as that file spells the folder; null where it kept none. */
  grantsKey: string | null
  /** The key its switch file kept the switch under; null where it kept none. */
  switchKey: string | null
  /** Whether its dangerously-allow switch survives: a registered workspace's needed the node's own on too. */
  keepSwitch: boolean
}

/**
 * What the move writes, and what the owner is told beside the notices: a name it had to change. `keyScopes` maps each
 * handle 0.1 named a workspace by in a device key's scope to its id now, and `movesKeys` says an enrolled key names one.
 */
interface Plan { plans: Planned[]; notes: string[]; keyScopes: ReadonlyMap<string, string>; movesKeys: boolean; rolledBack: boolean }

/** What a 0.1 node's files kept for one workspace, read whole before anything is written. */
interface Kept { policies: Record<string, WorkspacePolicy>; grants: string[]; switches: string[] }

/** The name a workspace takes where its own is empty: a folder's name never is, but a 0.1 id read from a hand-edited registry could be. */
const UNNAMED = 'workspace'
/** The longest name the registry reads (WorkspaceNameSchema). */
const NAME_LIMIT = 120

/** Asked for another name for the node's folder where a registered workspace holds the folder's name (D85, Q15); none without a terminal. */
export type AskName = (question: string) => Promise<string>

/**
 * Moves a node set up before the workspace model onto it, once, at the first start of a Buckle that has it (the
 * workspace-model brief, item 1, Q14, Q15; D85, Q15). workspaces.json becomes version 2: tokens kept as their sha256,
 * each workspace's admin credential dropped (the node's admin token is the one), `retiredAt` read as offline, and the
 * node's own folder stored as a workspace of its own, named after the folder, its folder BUCKLE_WORKSPACE_ROOT or the
 * directory this command runs in, its agent token BUCKLE_AUTH_TOKEN, each read from the environment file
 * (MigrationInput). Each workspace gets an id derived from its folder (workspaceIdFor), a registered one keeps its 0.1
 * id as its name, and each gets a workspace.json holding what was its own: the lists `buckle policy` stored for the
 * node's folder, and its mount where one was stored, or a registered one's own lists and its /workspace mount. The
 * node's settings in its environment file stay there, as every workspace's defaults (D85, Q3 and Q14): the move copies
 * none of them, so every other setting is unset and the node's applies, its allow-type lists where a workspace has none
 * of its own and its deny-type lists over every workspace's. Records move to `workspaces/<id>/`, grants and switches rekeyed from the
 * folder to the id. Owner-only copies of every file it changes are kept to go back to 0.1 with (REGISTRY_BACKUP);
 * policy.json becomes a version 2 file and BUCKLE_AUTH_TOKEN leaves the environment file, so an older Buckle sharing
 * the state directory refuses to start (fix brief 1, A3).
 *
 * Every file the move touches is read, and every record it writes checked against the registry's own reader, before
 * anything is written (finding 3 and 17 of the Phase 1 review), so a move that cannot finish refuses with
 * MigrationError and changes nothing; a move a crash stopped partway runs again to the same end, as each id derives
 * from its folder. Returns what the owner is told; on a node moved already, what its environment still sets that it no
 * longer reads. Throws WorkspaceRegistryError, as a version 2 registry that will not parse does, where version 1 will not.
 */
export async function migrateNode(input: { node: NodeConfig; platform?: NodeJS.Platform; askName?: AskName }): Promise<string[]> {
  const { node } = input
  const filePath = registryPath(node.stateDirectory)
  if (versionOf(filePath) === 2) {
    rmSync(join(node.stateDirectory, MOVING_MARKER), { force: true })
    return movedNodeNotices(node)
  }
  const store = createJsonFileStore({ filePath, schema: AnyRegistrySchema, fallback: { version: 0, workspaces: [] }, lockDeadlineMs: node.stateLockDeadlineMs })
  let moved: { plan: Plan; hadRegistry: boolean; refreshed: string[]; setAside: string[]; movedLog: boolean } | null
  try {
    moved = await store.update(async (raw) => {
      if (raw.version === 2) return null
      if (raw.version !== 0 && raw.version !== 1) throw new MigrationError(`${filePath} is version ${raw.version}, which this Buckle does not read; it was written by another release`)
      const hadRegistry = raw.version === 1
      const registered = hadRegistry ? version1Workspaces(filePath, raw) : []
      const plan = await beforeWriting(() => planMove({ ...input, platform: input.platform ?? process.platform, registered, hadRegistry }))
      if (plan.plans.length > 0) writeFileSync(join(node.stateDirectory, MOVING_MARKER), '', { mode: 0o600 })
      const refreshed = plan.plans.length > 0 ? keepRollbackCopies({ node, plans: plan.plans, registryFile: filePath, hadRegistry, movesKeys: plan.movesKeys }) : []
      const setAside: string[] = []
      let movedLog = false
      for (const planned of plan.plans) {
        const done = await partway(() => apply(node, planned, plan.rolledBack))
        setAside.push(...done.setAside)
        movedLog ||= done.movedLog
      }
      if (plan.movesKeys) await partway(() => rekeyClientKeys({ filePath: clientKeysPath(node), scopes: plan.keyScopes, lockDeadlineMs: node.stateLockDeadlineMs }))
      if (plan.plans.length > 0) await createJsonFileStore({ filePath: policyPath(node), schema: PolicyStubSchema, fallback: POLICY_STUB }).write(POLICY_STUB)
      raw.version = 2
      raw.workspaces = plan.plans.map(planned => planned.record)
      return { plan, hadRegistry, refreshed, setAside, movedLog }
    })
  } catch (error) {
    // Only workspaces.json itself is the registry: another file that will not read is named by a MigrationError.
    if (error instanceof StateFileError) throw new WorkspaceRegistryError(error.message, 409)
    throw error
  }
  if (moved === null) return movedNodeNotices(node)
  if (moved.plan.plans.length === 0) return []
  // The registry is version 2 now, so a move run again is no crash's to finish.
  rmSync(join(node.stateDirectory, MOVING_MARKER), { force: true })
  // Once the registry holds its digest: a crash before this leaves the line, which the start warning then names.
  const retired = await retireAuthToken(node)
  return [...notices({ node, plans: moved.plan.plans, hadRegistry: moved.hadRegistry, retired, movesKeys: moved.plan.movesKeys, refreshed: moved.refreshed, setAside: moved.setAside, movedLog: moved.movedLog }), ...moved.plan.notes]
}

/** Whether the state directory's registry is version 2 already, read without the lock. */
export function movedOntoWorkspaces(stateDirectory: string): boolean {
  return versionOf(registryPath(stateDirectory)) === 2
}

/** A file read before the move writes anything: one that will not read refuses the move, which has changed nothing. */
async function beforeWriting<R>(read: () => Promise<R>): Promise<R> {
  try { return await read() } catch (error) {
    if (error instanceof StateFileError) throw new MigrationError(`${error.message}, so Buckle cannot move the node onto workspaces. Nothing was changed.`)
    throw error
  }
}

/** A file the move writes: one that stopped reading meanwhile stops it partway, and the next start runs it again. */
async function partway<R>(write: () => Promise<R>): Promise<R> {
  try { return await write() } catch (error) {
    if (error instanceof StateFileError) throw new MigrationError(`${error.message}, so Buckle stopped moving the node onto workspaces partway; repair the file, and the next start finishes the move.`)
    throw error
  }
}

function version1Workspaces(filePath: string, raw: unknown): z.infer<typeof V1WorkspaceSchema>[] {
  const parsed = V1RegistrySchema.safeParse(raw)
  if (parsed.success) return parsed.data.workspaces
  throw new WorkspaceRegistryError(`${filePath} is version 1 but will not read: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}; owner repair is required`, 409)
}

/** The version a state file says it is, read without the lock: 0 where there is none, -1 where it cannot be read. */
function versionOf(filePath: string): number {
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
  const input = node.migration
  return hadRegistry || input.authToken !== '' || input.workspaceRoot !== undefined
    // A caller naming a 0.1 token or folder its file does not hold set the node up outside the file: the move refuses,
    // naming them, rather than leave the node with no workspace.
    || input.conflicts.some(key => key === 'BUCKLE_AUTH_TOKEN' || key === 'BUCKLE_WORKSPACE_ROOT')
    || [policyPath(node), grantsPath(node)].some(path => existsSync(path))
}

async function planMove(input: { node: NodeConfig; platform: NodeJS.Platform; registered: z.infer<typeof V1WorkspaceSchema>[]; hadRegistry: boolean; askName?: AskName }): Promise<Plan> {
  const { node, platform } = input
  if (!servedBefore(node, input.hadRegistry)) return { plans: [], notes: [], keyScopes: new Map(), movesKeys: false, rolledBack: false }
  refuseCallerSettings(node.migration)
  const now = new Date().toISOString()
  const notes: string[] = []
  const stateRoot = nativePath(realpathSync.native(node.stateDirectory))
  const dir = ownFolder({ node, platform, stateRoot })
  const roots = input.registered.map(workspace => ({ workspace, root: diskSpelling(workspace.root) }))
  for (const { workspace, root } of roots) {
    if (overlaps(root, dir, platform)) throw new MigrationError(`The node's own folder would become a workspace at ${dir}, which overlaps workspace ${workspace.id} at ${root}. Run this command from the folder buckle serve serves, or set BUCKLE_WORKSPACE_ROOT to it, so the node's folder keeps its place.`)
    if (overlaps(root, stateRoot, platform)) throw new MigrationError(`Workspace ${workspace.id} at ${root} overlaps the state directory ${stateRoot}, where an agent writing anywhere in its folder could rewrite Buckle's records; move one of them, then start Buckle again. Nothing was changed.`)
  }

  // The node's own folder: what `buckle policy` stored for it is its own; the environment's lists stay the node's (D85, Q3).
  const ownId = workspaceIdFor(dir)
  const ownState = join(node.stateDirectory, 'workspaces', ownId)
  // A node that went back to 0.1 and moves again: an earlier move kept its copy of the registry and left the workspaces'
  // directories, and none is under way (no marker). What 0.1 holds now is the node's, so the grants and switches the
  // earlier move left are not read (fix brief 4, finding 6).
  const rolledBack = !existsSync(join(node.stateDirectory, MOVING_MARKER)) && existsSync(join(node.stateDirectory, REGISTRY_BACKUP))
    && [ownId, ...roots.map(({ root }) => workspaceIdFor(root))].some(id => existsSync(join(node.stateDirectory, 'workspaces', id)))
  const own = kept({ policyFile: ownPolicyFile(node), stateDirectories: [node.stateDirectory, ownState], rolledBack })
  const ownSpellings = [dir, ...node.migration.workspaceRoot === undefined ? [] : [node.migration.workspaceRoot], ownId]
  const ownPolicy = keyOf({ keys: Object.keys(own.policies), spellings: ownSpellings, platform, file: policyPath(node) })
  const stored = ownPolicy === null ? null : own.policies[ownPolicy]!
  const ownSwitch = keyOf({ keys: own.switches, spellings: ownSpellings, platform, file: dangerouslyAllowPath(node) })
  // Named after its folder (D85, Q15), unless a registered workspace's 0.1 id, which is its name now, is the same word.
  const registeredNames = roots.map(({ workspace }) => workspace.id)
  const ownName = await folderName({ dir, id: ownId, taken: registeredNames, notes, askName: input.askName })
  const ownPlan: Planned = {
    record: { id: ownId, name: ownName, dir, online: true, nodeFolder: true, revision: 0, updatedAt: now, createdAt: now,
      tokens: node.migration.authToken ? [{ id: NODE_TOKEN_ID, sha256: tokenDigest(node.migration.authToken), label: 'BUCKLE_AUTH_TOKEN', createdAt: now }] : [] },
    // A mount `buckle policy mount` stored is its own; else it shows where BUCKLE_WORKSPACE_MOUNT says, as before.
    settings: withMount(withPolicy(unset(), stored ?? emptyWorkspacePolicy()), stored?.mount ?? undefined),
    oldStateDirectory: node.stateDirectory,
    stateDirectory: ownState,
    nodeFolder: true,
    grantsKey: keyOf({ keys: own.grants, spellings: ownSpellings, platform, file: grantsPath(node) }),
    switchKey: ownSwitch,
    keepSwitch: true,
  }
  notes.push(...standsAlone(`The node's folder's workspace ${ownName}`, stored, node))
  const nodeSwitch = ownSwitch !== null
  const registered = roots.map(({ workspace, root }): Planned => {
    const id = workspaceIdFor(root)
    const oldStateDirectory = join(node.stateDirectory, 'workspaces', workspace.id)
    const stateDirectory = join(node.stateDirectory, 'workspaces', id)
    const records = kept({ policyFile: policyPath({ stateDirectory: oldStateDirectory }), stateDirectories: [oldStateDirectory, stateDirectory], rolledBack })
    // 0.1 keyed a registered workspace's records by its folder as the disk names it (finding 18); a move run again finds them under the id.
    const spellings = [root, workspace.root, id]
    const policyKey = keyOf({ keys: Object.keys(records.policies), spellings, platform, file: policyPath({ stateDirectory: oldStateDirectory }) })
    const ownLists = policyKey === null ? workspace.policy : records.policies[policyKey]!
    notes.push(...standsAlone(`Workspace ${workspace.id}`, ownLists, node))
    // Its 0.1 id is the handle its MCP configs name, so that is its name (D85, Q15); its 0.1 display name is said in a note.
    if (workspace.name.trim() !== '' && workspace.name.trim() !== workspace.id) notes.push(`Workspace ${workspace.id} was shown as ${workspace.name.trim()} before; its name is now ${workspace.id}, the handle --workspace takes, and buckle workspace rename ${workspace.id} <name> gives it another.`)
    return {
      record: { id, name: fittingName({ label: `Workspace ${workspace.id}`, name: workspace.id, notes }), dir: root, online: workspace.enabled && !workspace.retiredAt, revision: 0, updatedAt: workspace.updatedAt ?? now, createdAt: now,
        tokens: workspace.tokens.map(token => ({ id: token.id, sha256: tokenDigest(token.token), label: token.label, createdAt: token.createdAt })) },
      // Its own lists, and the /workspace mount 0.1 gave every registered workspace; every other setting is the node's.
      settings: withMount(withPolicy(unset(), ownLists), WORKSPACE_MOUNT_TARGET),
      oldStateDirectory,
      stateDirectory,
      nodeFolder: false,
      grantsKey: keyOf({ keys: records.grants, spellings, platform, file: grantsPath({ stateDirectory: oldStateDirectory }) }),
      switchKey: keyOf({ keys: records.switches, spellings, platform, file: dangerouslyAllowPath({ stateDirectory: oldStateDirectory }) }),
      keepSwitch: nodeSwitch,
    }
  })
  const plans = [ownPlan, ...registered]
  refuseUnreadable(plans)
  // Device keys 0.1 enrolled for a workspace name it by its 0.1 id, `default` for the node's folder; each now names its id.
  const keyScopes = new Map<string, string>([...roots.map(({ workspace }, index): [string, string] => [workspace.id, registered[index]!.record.id]), [V1_NODE_WORKSPACE, ownId]])
  keyScopes.delete(NODE_SCOPE)
  const movesKeys = clientKeyScopes(clientKeysPath(node)).some(scope => keyScopes.has(scope))
  return { plans, notes, keyScopes, movesKeys, rolledBack }
}

/** A workspace's settings with nothing of its own set: every setting the node's, else Buckle's (D85, Q3). */
function unset(): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse({ version: 1 })
}

/** The node's allow-type lists, by the variable that holds each and how a policy holds it. */
const ALLOW_TYPE_LISTS: ReadonlyArray<[string, string, (policy: WorkspacePolicy) => readonly string[]]> = [
  ['BUCKLE_COMMAND_ALLOW', 'command allow list', policy => policy.commands.allow],
  ['BUCKLE_ALLOWED_INTERPRETERS', 'interpreter list', policy => allowedInterpreters(policy)],
  ['BUCKLE_NETWORK_ALLOW', 'approved URL list', policy => policy.network.allow],
]

/**
 * What the owner is told where a workspace keeps an allow-type list of its own beside the node's (D85, Q14): it now uses
 * its own alone, where the node's was a ceiling over a registered workspace's, and joined with the node's folder's.
 */
function standsAlone(label: string, own: WorkspacePolicy | null, node: NodeConfig): string[] {
  if (own === null) return []
  const lists = ALLOW_TYPE_LISTS.filter(([, , list]) => list(own).length > 0 && list(node.workspaceDefaults.policy).length > 0)
  if (lists.length === 0) return []
  const names = lists.map(([, name]) => name)
  const keys = lists.map(([key]) => key)
  return [`${label} keeps its own ${names.join(' and ')}, which it now uses alone: the node's ${keys.join(' and ')} ${keys.length === 1 ? 'applies' : 'apply'} only to a workspace without one of its own (docs/workspaces-03.md). Add to its list with buckle policy where it needs what the node's admitted.`]
}

/**
 * The folder the node's own workspace takes: refused where it holds the state directory or sits inside it, as `buckle
 * workspace init` refuses the same folder (finding 19), since an agent writes anywhere in its workspace, and where it
 * overlaps a host toolchain or read-only mount, which every workspace is held to now (D85, Q15): the workspace would
 * refuse to open at every call, so the move says so first and changes nothing.
 */
function ownFolder(input: { node: NodeConfig; platform: NodeJS.Platform; stateRoot: string }): string {
  let dir: string
  try { dir = legacyWorkspaceRoot(input) } catch (error) {
    throw new MigrationError(`The node's own folder cannot become a workspace: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (overlaps(dir, input.stateRoot, input.platform)) throw new MigrationError(`The node's own folder would become a workspace at ${dir}, which overlaps the state directory ${input.stateRoot}. Run this command from the folder buckle serve serves, or set BUCKLE_WORKSPACE_ROOT to it. Nothing was changed.`)
  return dir
}

/**
 * The node folder's name (D85, Q15): the folder's own, cut to what the registry reads. Where a registered workspace's
 * 0.1 id, which is its name now, is the same word, the owner is asked for another at a terminal; without one, or with
 * an answer that is taken or refused too, the folder's name with the first eight characters of its id, said in a note.
 */
async function folderName(input: { dir: string; id: string; taken: readonly string[]; notes: string[]; askName?: AskName }): Promise<string> {
  const name = fittingName({ label: `The node's folder ${input.dir}`, name: basename(input.dir), notes: input.notes })
  /** Why a name cannot be the folder's, or null: another workspace holds it, or the registry would not read it (`node`, a UUID's form). */
  const unfit = (candidate: string): string | null => {
    if (input.taken.some(other => sameName(other, candidate))) return `a registered workspace is named ${candidate} already`
    const parsed = WorkspaceNameSchema.safeParse(candidate)
    return parsed.success ? null : `${candidate} cannot be a workspace name (${parsed.error.issues.map(issue => issue.message).join('; ')})`
  }
  const reason = unfit(name)
  if (reason === null) return name
  const fallback = `${name}-${input.id.slice(0, 8)}`
  const answer = input.askName === undefined ? '' : (await input.askName(`The node's folder ${input.dir} would be workspace ${name}, but ${reason}. Another name for the folder, or Enter for ${fallback}: `)).trim()
  if (answer !== '' && unfit(answer) === null) return answer
  input.notes.push(`The node's folder ${input.dir} is workspace ${fallback}: ${reason}${answer === '' ? '' : `, and ${answer} could not be used`}. Rename it with buckle workspace rename ${workspaceArgument(fallback)} <name>.`)
  return fallback
}

/** policy.json as 0.1 left it: its copy, where a move a crash stopped already put the stub in its place. */
function ownPolicyFile(node: NodeConfig): string {
  return versionOf(policyPath(node)) === 2 ? join(node.stateDirectory, POLICY_BACKUP) : policyPath(node)
}

/**
 * Copies of every file the move changes, owner-only, beside where 0.1 kept the file (REGISTRY_BACKUP). Each is made from
 * the file as it is, so a node that went back to 0.1 and moves again keeps the copies of what 0.1 holds now (fix brief 4,
 * finding 6); a file already moved, which a move a crash stopped leaves, keeps the copy made before it moved. A policy
 * file that is the stub already, and a registry the node never had, keep the empty version 1 file 0.1 reads as none.
 * Answers the copies that held something else before, which the owner is told were made again.
 */
function keepRollbackCopies(input: { node: NodeConfig; plans: Planned[]; registryFile: string; hadRegistry: boolean; movesKeys: boolean }): string[] {
  const state = input.node.stateDirectory
  const refreshed: string[] = []
  const copy = (from: string, to: string) => {
    const text = readFileSync(from, 'utf8')
    if (existsSync(to) && readFileSync(to, 'utf8') !== text) refreshed.push(relative(state, to))
    writeFileSync(to, text, { mode: 0o600 })
    setMode(to, 0o600)
  }
  if (input.hadRegistry) copy(input.registryFile, join(state, REGISTRY_BACKUP))
  else keepOnce(join(state, REGISTRY_BACKUP), EMPTY_REGISTRY_V1)
  if (input.movesKeys) copy(clientKeysPath(input.node), join(state, CLIENT_KEYS_BACKUP))
  const policy = policyPath(input.node)
  if (versionOf(policy) !== 2) {
    if (existsSync(policy)) copy(policy, join(state, POLICY_BACKUP))
    else keepOnce(join(state, POLICY_BACKUP), EMPTY_POLICY_V1)
  }
  for (const { oldStateDirectory } of input.plans) {
    for (const [file, name] of [[grantsPath({ stateDirectory: oldStateDirectory }), GRANTS_BACKUP], [dangerouslyAllowPath({ stateDirectory: oldStateDirectory }), SWITCH_BACKUP]] as const) {
      if (existsSync(file)) copy(file, join(oldStateDirectory, name))
    }
  }
  return refreshed
}

function keepOnce(path: string, text: string): void {
  if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600 })
}

/**
 * Takes BUCKLE_AUTH_TOKEN out of the environment file once the registry holds it as the node folder's token `node`,
 * so 0.1's buckle serve, which needs it, refuses to start (finding 14), and so the file no longer looks like where the
 * token is changed (finding 20). Answers what the owner is told where the line could not be taken out.
 */
async function retireAuthToken(node: NodeConfig): Promise<string[]> {
  const file = node.migration.file
  if (file === null || node.migration.authToken === '') return []
  const handEdit = (reason: string) => [`BUCKLE_AUTH_TOKEN could not be taken out of ${file} (${reason}); remove its line by hand, as the node no longer reads it.`]
  try {
    const edit = await updateEnvironmentFile(file, text => editEnvironmentVariable({ text, name: 'BUCKLE_AUTH_TOKEN', value: null }))
    return edit.ok ? [] : handEdit(edit.reason)
  } catch (error) {
    return handEdit(error instanceof Error ? error.message : String(error))
  }
}

/** A folder as 0.1's runtime named it when it keyed the folder's records: links followed, in the disk's case; as stored where it is gone. */
function diskSpelling(root: string): string {
  try { return nativePath(realpathSync.native(root)) } catch { return root }
}

/**
 * What a 0.1 node's files kept for one workspace: its stored policies from `policyFile`, and the keys of its grants and
 * switch files in each directory they may be in, where 0.1 kept them and where a move run again finds them moved;
 * StateFileError where one will not read.
 */
function kept(input: { policyFile: string; stateDirectories: readonly string[]; rolledBack: boolean }): Kept {
  // Where the node went back to 0.1, only the files 0.1 holds, in its own place, are the node's.
  const union = (read: (file: string) => string[], name: (stateDirectory: string) => string) => [...new Set((input.rolledBack ? input.stateDirectories.slice(0, 1) : input.stateDirectories).flatMap(stateDirectory => read(name(stateDirectory))))]
  return {
    policies: readStoredPolicies(input.policyFile),
    grants: union(grantKeys, stateDirectory => grantsPath({ stateDirectory })),
    switches: union(switchKeys, stateDirectory => dangerouslyAllowPath({ stateDirectory })),
  }
}

/**
 * The key a 0.1 file kept a folder's records under, by any of its spellings, compared as the volume compares paths: on
 * macOS and Windows a case-only rename leaves the records under the old case (finding 18). Two keys naming the one
 * folder are refused rather than one picked.
 */
function keyOf(input: { keys: readonly string[]; spellings: readonly string[]; platform: NodeJS.Platform; file: string }): string | null {
  const caseless = ignoresCase(input.platform)
  const same = (key: string, spelling: string) => key === spelling || (caseless && comparablePath(key, true) === comparablePath(spelling, true))
  const matching = input.keys.filter(key => input.spellings.some(spelling => same(key, spelling)))
  if (matching.length > 1) throw new MigrationError(`${input.file} keeps records under ${matching.length} spellings of one folder (${matching.join(', ')}), so Buckle cannot tell which the node used; keep one, then start Buckle again. Nothing was changed.`)
  return matching[0] ?? null
}

/** What a name given now may not hold, since a route cannot carry it as typed (NewWorkspaceNameSchema). */
const UNREACHABLE = /[/\\%\u0000-\u001f\u007f]+/g

/**
 * A name the registry reads (WorkspaceNameSchema, finding 3): one over 120 characters is cut at a word's end, an empty
 * one is a fixed word, and a character a route cannot carry becomes a hyphen (fix brief 4, finding 37); the owner is
 * told in each case.
 */
function fittingName(input: { label: string; name: string; notes: string[] }): string {
  const trimmed = input.name.trim()
  const carried = trimmed.replace(UNREACHABLE, '-')
  const plain = carried === '.' || carried === '..' ? '' : carried
  if (plain === trimmed && trimmed !== '' && trimmed.length <= NAME_LIMIT) return trimmed
  const fit = (plain === '' ? '' : cutName(plain)) || UNNAMED
  const why = trimmed === '' ? 'was empty'
    : plain !== trimmed ? 'held a character no route can carry in a name (/, \\, %, or a control character), or was only dots'
      : `was ${trimmed.length} characters, more than the ${NAME_LIMIT} a workspace name holds`
  input.notes.push(`${input.label}'s name ${why}, so it is named ${fit}; rename it with buckle workspace rename ${workspaceArgument(fit)} <name>.`)
  return fit
}

/** The first 120 characters, ended at the last word's end in their second half where there is one. */
function cutName(name: string): string {
  const head = name.slice(0, NAME_LIMIT + 1)
  const end = Math.max(-1, ...[...head.matchAll(/[\s\-_./\\]/g)].map(match => match.index))
  return (end >= NAME_LIMIT / 2 ? head.slice(0, end) : head.slice(0, NAME_LIMIT)).replace(/[\s\-_./\\]+$/, '')
}

/** Every record checked as the registry's reader will check it, so the move never writes a registry it then refuses (finding 3). */
function refuseUnreadable(plans: Planned[]): void {
  const checked = RegistrySchema.safeParse({ version: 2, workspaces: plans.map(planned => planned.record) })
  if (checked.success) return
  const issues = checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  throw new MigrationError(`The registry this move would write will not read (${issues}), so Buckle cannot move the node onto workspaces; repair the version 1 entries of workspaces.json named there, then start Buckle again. Nothing was changed.`)
}

/**
 * The move reads the node's token and folder from its environment file alone; a shell's or an MCP config's env that says
 * otherwise would make its own the node's for good (finding 34), so it refuses, naming the keys, never a value. A deny
 * list the caller names otherwise refuses it too (fix brief 4, finding 8): 0.1 enforced the caller's, and dropping it
 * would lift what the node enforced.
 */
function refuseCallerSettings(input: MigrationInput): void {
  refuseDroppedFloor(input.floorConflicts, input.file)
  if (input.conflicts.length === 0) return
  const keys = input.conflicts.join(', ')
  const one = input.conflicts.length === 1
  throw new MigrationError(`${keys} ${one ? 'is' : 'are'} set in this command's environment to another value than ${input.file} holds. Buckle moves the node onto workspaces from that file alone, so a shell's or an MCP config's env never becomes a workspace's token or folder: remove ${one ? 'it' : 'them'} from the environment this command runs in, or give the file the same value, then start Buckle again. Nothing was changed.`)
}

/**
 * The refusal for deny-type lists the caller names otherwise than the file: the keys and the repair, never a value or a
 * path. Where the node has no file, `buckle settings set` has none to write, so the repair starts with `buckle init`.
 */
function refuseDroppedFloor(keys: readonly string[], file: string | null): void {
  if (keys.length === 0) return
  const one = keys.length === 1
  const repairs = keys.map(key => `buckle settings set ${key} '<globs separated by ;;>'`).join(' and ')
  const held = file === null ? ', but this node has no environment file, buckle.env' : ' to other entries than the node\'s environment file holds'
  const repair = file === null ? `Run buckle init to write the file, then ${repairs}` : `Put ${one ? 'the list' : 'each list'} in the file with ${repairs}`
  throw new MigrationError(`${keys.join(', ')} ${one ? 'is' : 'are'} set in this command's environment${held}. Before the workspace model the environment's list applied; from the move on the node reads ${one ? 'it' : 'them'} from the file alone, so moving now would drop entries the node enforced. ${repair}, or remove ${one ? 'the variable' : 'the variables'} from the environment this command runs in, then start Buckle again. Nothing was changed.`)
}

/**
 * One workspace's move: its records into `workspaces/<id>/`, its settings written there, and its grants and switch
 * rekeyed from the folder to the id. Each step finds its work done on a move run again, so a crash partway is finished
 * at the next start.
 */
async function apply(node: NodeConfig, planned: Planned, rolledBack: boolean): Promise<{ setAside: string[]; movedLog: boolean }> {
  const { record, stateDirectory } = planned
  const lockDeadlineMs = node.stateLockDeadlineMs
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const setAside = moveRecords(planned, rolledBack)
  const movedLog = planned.nodeFolder && await moveAuditLog(node, planned)
  await openSettingsFile({ filePath: settingsPath(node.stateDirectory, record.id), lockDeadlineMs }).migrate(planned.settings)
  if (planned.grantsKey !== null) await rekeyGrants({ filePath: grantsPath({ stateDirectory }), from: planned.grantsKey, to: record.id, lockDeadlineMs })
  if (planned.switchKey !== null) await rekeySwitch({ filePath: dangerouslyAllowPath({ stateDirectory }), from: planned.switchKey, to: planned.keepSwitch ? record.id : null, lockDeadlineMs })
  return { setAside, movedLog }
}

/**
 * Moves what 0.1 kept for the workspace into its own directory (D85, Q15): the named set from the state directory for
 * the node's folder, and everything but what stays behind (STAYS_BEHIND) from a registered workspace's 0.1 directory.
 * A record already moved, or never kept, is left alone, so a move run again changes nothing more. Where a record is in
 * both places, the node went back to 0.1 and moves again: the one an earlier move left is set aside beside the one 0.1
 * holds now, which takes its place, and the grants and the switch an earlier move left are set aside even where 0.1 has
 * none (an audit log is neither: it stays where it is). Answers what was set aside, as a path inside the state directory.
 */
function moveRecords(planned: Planned, rolledBack: boolean): string[] {
  const entries = planned.nodeFolder ? NODE_FOLDER_RECORDS : listed(planned.oldStateDirectory).filter(entry => !STAYS_BEHIND.test(entry))
  const aside: string[] = []
  const setAside = (path: string) => {
    let target = `${path}.earlier-move`
    for (let count = 2; existsSync(target); count++) target = `${path}.earlier-move-${count}`
    renameSync(path, target)
    aside.push(relative(dirname(dirname(planned.stateDirectory)), target))
  }
  if (rolledBack) {
    for (const stale of [grantsPath({ stateDirectory: planned.stateDirectory }), dangerouslyAllowPath({ stateDirectory: planned.stateDirectory })]) if (existsSync(stale)) setAside(stale)
  }
  for (const entry of entries) {
    const from = join(planned.oldStateDirectory, entry)
    const to = join(planned.stateDirectory, entry)
    if (!existsSync(from)) continue
    if (existsSync(to)) {
      if (AUDIT_LOG.test(entry)) continue
      setAside(to)
    }
    renameSync(from, to)
  }
  return aside
}

const PendingAuditSchema = z.object({ version: z.literal(1), pending: z.record(z.string(), z.object({ processId: z.number() }).passthrough()) })

/**
 * The 0.1 node's audit log held every call of the node's folder, and its owner's commands beside them. It becomes the
 * folder's workspace's log, so `buckle log --workspace <name>` reads what the folder's agents did before the move, and
 * the node's own log starts fresh with the owner's commands (fix brief 4, findings 17 and 18). The attempts it still
 * tracks as open move with it, but for this very process's, whose results the node's log will record. A workspace that
 * has a log already (a node that went back to 0.1 and moves again) keeps it, and the old one stays where it is; so does
 * a log whose open attempts will not read. Answers whether the log moved.
 */
async function moveAuditLog(node: NodeConfig, planned: Planned): Promise<boolean> {
  const from = actionsPath(node)
  const to = join(planned.stateDirectory, 'actions.jsonl')
  if (!existsSync(from) || existsSync(to)) return false
  const lockDeadlineMs = node.stateLockDeadlineMs
  const fallback: z.infer<typeof PendingAuditSchema> = { version: 1, pending: {} }
  const open = { schema: PendingAuditSchema, fallback, lockDeadlineMs }
  const source = createJsonFileStore({ filePath: `${from}.pending.json`, ...open })
  const target = createJsonFileStore({ filePath: `${to}.pending.json`, ...open })
  try {
    const leaving = Object.entries(source.read().pending).filter(([, attempt]) => attempt.processId !== process.pid)
    if (leaving.length > 0) {
      await target.update((state) => { for (const [id, attempt] of leaving) state.pending[id] = attempt })
      await source.update((state) => { for (const [id] of leaving) delete state.pending[id] })
    }
  } catch (error) {
    if (error instanceof StateFileError) return false
    throw error
  }
  renameSync(from, to)
  return true
}

function listed(directory: string): string[] {
  try { return readdirSync(directory) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

function notices(input: { node: NodeConfig; plans: Planned[]; hadRegistry: boolean; retired: string[]; movesKeys: boolean; refreshed: string[]; setAside: string[]; movedLog: boolean }): string[] {
  const own = input.plans.find(planned => planned.nodeFolder)
  if (!own) return []
  const token = input.node.migration.authToken !== ''
  const file = input.node.migration.file
  const named = workspaceArgument(own.record.name)
  return [
    `Buckle moved this node to the workspace model: workspaces.json is version 2, and the node's own folder ${own.record.dir} is workspace ${own.record.name} (id ${own.record.id}), with its records in workspaces/${own.record.id}/ in the state directory. The registry and policy files it changed are kept as ${REGISTRY_BACKUP} and ${POLICY_BACKUP} in the state directory, with ${GRANTS_BACKUP} and ${SWITCH_BACKUP} beside where each grants and switch file it moved was, for going back to 0.1 (docs/workspaces-04.md). An older Buckle sharing this state directory now refuses to start: policy.json is a version 2 file it cannot read.`,
    ...(token ? [`BUCKLE_AUTH_TOKEN is now token node of workspace ${own.record.name}, so agents configured with it keep working${file === null ? '; the node no longer reads the variable, so remove it from the environment Buckle starts with' : `, and it was taken out of ${file}, which the node no longer reads it from`}. Buckle keeps the token as its digest alone, with no copy of its value: to go back to 0.1, set BUCKLE_AUTH_TOKEN again from an agent's own configuration. To rotate it, run buckle workspace token create --workspace ${named}, give agents the new token, then buckle workspace token revoke node --workspace ${named}.`] : []),
    ...input.retired,
    ...(input.movesKeys ? [`Each device key enrolled for a workspace now names the workspace's id, so it keeps signing for it; ${CLIENT_KEYS_BACKUP} in the state directory keeps the keys as 0.1 named them, for going back to 0.1.`] : []),
    ...(input.plans.length > 1 ? ['Each registered workspace\'s admin credential is retired: the node\'s admin token opens every workspace. Each keeps its 0.1 id as its name, the handle --workspace takes, and has an id of its own now; its records moved to workspaces/<id>/, and its 0.1 folder there keeps the copies for going back.'] : []),
    ...(input.movedLog ? [`The node's audit log from before the move held its folder's calls, and is now workspace ${own.record.name}'s log: buckle log --workspace ${named} reads it. The node's own log in the state directory starts fresh with the commands you run.`] : []),
    ...(input.refreshed.length > 0 ? [`This node was moved onto workspaces before and went back to 0.1. The copies kept for going back to 0.1 were made again from the files 0.1 holds now: ${input.refreshed.join(', ')}.`] : []),
    ...(input.setAside.length > 0 ? [`Records the earlier move left were set aside, and the records 0.1 holds now moved in their place: ${input.setAside.join(', ')}. Delete them once you no longer need them.`] : []),
    ...(input.hadRegistry ? [`${REGISTRY_BACKUP} holds the registered workspaces' agent tokens and admin credentials in clear text: once the node works as it should, delete every *.v1.json file in the state directory and in its workspaces folders.`] : []),
    ...rootLineNotice(input.node),
  ]
}

/**
 * The BUCKLE_WORKSPACE_ROOT line 0.1's buckle init always wrote: read once, as the node folder's workspace's folder, and
 * never by `buckle mcp`, which takes it only from an MCP config's own env (fix brief 1, B; findings 1 and 13).
 */
function rootLineNotice(node: NodeConfig): string[] {
  const file = node.migration.file
  if (file === null || node.migration.workspaceRoot === undefined) return []
  return [`${file} sets BUCKLE_WORKSPACE_ROOT, which the node reads only when it moves onto workspaces, as the folder of the workspace it makes of it. A plain buckle mcp never serves that folder for it: it serves the workspace holding the directory it starts in, or the folder an MCP config's own env names in BUCKLE_WORKSPACE_ROOT. Add --workspace <name> to your MCP configs, then, once you no longer need the way back to 0.1, run buckle settings unset root.`]
}

/**
 * What a node already on the workspace model is told at each start about what it no longer reads (fix brief 1, A5 and
 * B): a BUCKLE_AUTH_TOKEN changed in buckle.env, the 0.1 way to rotate it, would otherwise leave the old token working
 * unseen (finding 22), and the BUCKLE_WORKSPACE_ROOT line no longer steers `buckle mcp`.
 */
function movedNodeNotices(node: NodeConfig): string[] {
  const where = node.migration.file !== null && node.migration.authToken !== '' ? `in ${node.migration.file}` : 'in the environment'
  const holder = node.authToken === '' ? undefined : workspaceArgument(nodeTokenHolder(node) ?? 'the workspace made from the node\'s folder')
  return [
    ...(holder === undefined ? [] : [`BUCKLE_AUTH_TOKEN is set ${where}, but a node on the workspace model does not read it: the token it held when the node moved is token node of workspace ${holder}, and changing the variable changes nothing. Rotate the token with buckle workspace token create --workspace ${holder}, then buckle workspace token revoke node --workspace ${holder}, and remove the variable.`]),
    ...rootLineNotice(node),
  ]
}

/** The name of the workspace holding token `node`, or undefined where the registry does not say. */
function nodeTokenHolder(node: NodeConfig): string | undefined {
  try { return openRegistry({ stateDirectory: node.stateDirectory, lockDeadlineMs: node.stateLockDeadlineMs }).read().workspaces.find(workspace => workspace.tokens.some(token => token.id === NODE_TOKEN_ID))?.name } catch { return undefined }
}
