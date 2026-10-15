import { mkdirSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { allowedInterpreters, CommandPolicySchema, destructivePatterns, emptyWorkspacePolicy, MountPathSchema, NetworkPolicySchema, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore, fileVersion, StateFileError } from '../../adapters/json-file-store.js'
import { isSecretName } from '../../domain/environment.js'
import { compilePolicy, PolicyError } from '../../domain/policy.js'
import { DEFAULT_APPROVAL_WAIT_MS, parseBrowserSettings, type NodeDefaults, type WorkspaceScope } from '../../runtime/config.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { BUILTIN_PACKS } from '../packs/index.js'

/** The browser's idle timeout when a workspace names none, and its bounds (Q10 of the workspace-model brief): 60 s to 24 h. */
export const DEFAULT_BROWSER_IDLE_MS = 300_000
export const BROWSER_IDLE_BOUNDS = Object.freeze({ min: 60_000, max: 86_400_000 })

/** Where a workspace's folder shows to the agent when `buckle workspace init` makes it (D84 (3)). */
export const WORKSPACE_MOUNT_TARGET = '/workspace'

/** Names Buckle sets for a command itself (Q11), and its own settings, which no workspace variable may stand in for. */
const RESERVED_VARIABLES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'])
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const KEY_WORD = /(?:^|_)KEYS?(?:_|$)/i

/**
 * Why a workspace variable may not have this name, or null (Q13): a Buckle setting, or a name Buckle sets for every
 * command, is refused; a credential-like name is taken but warned about (credentialLikeName), since its value is plain
 * text in workspace.json and reaches every command. The refusal of a value that holds one of the node's own secrets
 * stays, in the CLI (credentialValueRefusal).
 */
export function variableNameRefusal(name: string): string | null {
  if (!VARIABLE_NAME.test(name)) return `${name} is not a variable name: letters, digits and underscores, not starting with a digit`
  if (name.toUpperCase().startsWith('BUCKLE_')) return `${name} names a Buckle setting, which a workspace variable cannot set`
  if (RESERVED_VARIABLES.has(name.toUpperCase())) return `${name} is set by Buckle for every command, not by a workspace`
  return null
}

/** Whether a variable's name reads like a credential (a token, secret, password, or key): taken, but warned about (Q13). */
export function credentialLikeName(name: string): boolean {
  return isSecretName(name) || KEY_WORD.test(name)
}

const PACK_IDS = BUILTIN_PACKS.map(pack => pack.id)

/**
 * A setting absent from workspace.json is unset, and the node's value stands for it, else Buckle's own (D85, Q3;
 * resolveSettings); `buckle workspace unset` takes a key out.
 */
const PacksSchema = z.object({
  /** Null offers every built-in pack and plugins; a list offers those packs alone, and no plugins. */
  enabled: z.array(z.string().refine(id => PACK_IDS.includes(id), { error: issue => `Unknown pack ${String(issue.input)}; packs: ${PACK_IDS.join(', ')}` })).min(1).nullable().optional(),
  shell: z.boolean().optional(),
  code: z.boolean().optional(),
  hostGit: z.boolean().optional(),
  hostLsp: z.boolean().optional(),
}).strict()

/** Settings names in a refusal, in place of the environment variables the shared checks name (parseBrowserSettings). */
const BROWSER_KEYS: ReadonlyArray<[string, string]> = [['BUCKLE_BROWSER_CDP', 'browser.cdp'], ['BUCKLE_BROWSER_PROFILE', 'browser.profile'], ['BUCKLE_BROWSER_ARGS', 'browser.args'], ['BUCKLE_BROWSER_HEADED', 'browser.headed']]

/**
 * Stored, from migration, and checked at each write (browserSettingsRefusal); the browser pack reads them per workspace
 * in the mount and browser phase (Q10), and `buckle workspace set` changes them from then; until then the node's own
 * browser settings drive it.
 */
const BrowserSchema = z.object({
  idleTimeoutMs: z.number().int().min(BROWSER_IDLE_BOUNDS.min).max(BROWSER_IDLE_BOUNDS.max).optional(),
  cdp: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  args: z.string().min(1).optional(),
  headed: z.boolean().optional(),
}).strict()

/**
 * Why the browser settings are refused on this platform, or null: the checks the node's own settings meet (an attached
 * browser beside a profile, arguments, or a window; a profile that is no absolute path; arguments Buckle refuses),
 * naming the settings and never a value.
 */
export function browserSettingsRefusal(browser: Pick<ResolvedSettings['browser'], 'cdp' | 'profile' | 'args'> & { headed?: boolean }, platform: NodeJS.Platform = process.platform): string | null {
  try {
    parseBrowserSettings({ BUCKLE_BROWSER_CDP: browser.cdp, BUCKLE_BROWSER_PROFILE: browser.profile, BUCKLE_BROWSER_ARGS: browser.args, ...(browser.headed ? { BUCKLE_BROWSER_HEADED: 'true' } : {}) }, platform)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return BROWSER_KEYS.reduce((text, [from, to]) => text.replaceAll(from, to), message)
  }
}

/** The workspace's folder in the agent's view. The mount phase adds system and owner entries beside it (Q1, Q6). */
const MountSchema = z.object({
  kind: z.literal('workspace'),
  target: MountPathSchema,
  access: z.literal('write'),
}).strict().superRefine((mount, context) => {
  try { compilePolicy({ ...emptyWorkspacePolicy(), mount: mount.target }) } catch (error) {
    if (error instanceof PolicyError) context.addIssue({ code: 'custom', message: error.message })
    else throw error
  }
})

const EnvironmentSchema = z.record(z.string(), z.string().max(4096).refine(value => !value.includes('\0'), 'A value cannot hold a NUL character')).superRefine((variables, context) => {
  for (const name of Object.keys(variables)) {
    const refusal = variableNameRefusal(name)
    if (refusal) context.addIssue({ code: 'custom', message: refusal, path: [name] })
  }
}).refine(variables => Object.keys(variables).length <= 200, 'At most 200 variables')

/**
 * The policy lists alone: where the folder shows lives in `mounts`, so one place says it. An empty list is no list of the
 * workspace's own (resolvePolicy). Patterns are compiled at each
 * write (openSettingsFile), not at each read, so a stored entry a later grammar refuses still reads and can be removed
 * with `buckle policy remove` (StoredPolicyError). Strict at every level, as the rest of the file is, with local strict
 * copies of the protocol's schemas: a misspelled list in a hand edit refuses the file, so the settings in force stay,
 * where dropping it would loosen the policy (finding 25 of the Phase 1 review).
 */
const SettingsPolicySchema = WorkspacePolicySchema.extend({
  commands: CommandPolicySchema.strict().default({ allow: [], deny: [] }),
  network: NetworkPolicySchema.strict().default({ allow: [] }),
}).strict().refine(policy => policy.mount === null, { message: 'policy.mount is not stored here; the workspace mount in mounts says where the folder shows', path: ['mount'] })

/**
 * One workspace's settings (D83, the workspace-model brief item 2): written by the owner's CLI alone, through the
 * locked store, and read by a running node at each call (Q2). It holds no credential, so `buckle workspace show`
 * prints it whole. It holds what the workspace sets alone (D85, Q3): every other setting is the node's, else Buckle's
 * own (resolveSettings).
 */
export const WorkspaceSettingsSchema = z.object({
  version: z.literal(1),
  /** Counts the writes, so a change made from two terminals at once is refused rather than lost. */
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.iso.datetime().nullable().default(null),
  policy: SettingsPolicySchema.default(emptyWorkspacePolicy),
  /** Where the folder shows: one entry, or none for its real path. Absent, the node's BUCKLE_WORKSPACE_MOUNT says. */
  mounts: z.array(MountSchema).max(1).optional(),
  /** Its own variables, over the node's key by key. */
  env: EnvironmentSchema.default({}),
  packs: PacksSchema.default({}),
  browser: BrowserSchema.default({}),
  /** Milliseconds a gated call is held for an answer when its caller sends no wait of its own; 0 holds it until someone answers. */
  approvalWaitMs: z.number().int().min(0).max(2_147_483_647).optional(),
}).strict()
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>

/**
 * The node's packs default, checked as a workspace's own is when the node opens its workspaces, so a pack Buckle does
 * not have stops the node, naming the variable, rather than leave every workspace that takes it unable to open.
 */
export function assertNodeDefaults(node: NodeDefaults): void {
  const unknown = (node.packs.enabled ?? []).filter(id => !PACK_IDS.includes(id))
  if (unknown.length > 0) throw new Error(`Invalid BUCKLE_PACKS: Unknown pack ${unknown.join(', ')}; packs: ${PACK_IDS.join(', ')}`)
}

/** A new workspace's settings: the folder at /workspace (D84 (3)), and every other setting the node's, else Buckle's own. */
export function defaultSettings(): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse({ version: 1, mounts: [{ kind: 'workspace', target: WORKSPACE_MOUNT_TARGET, access: 'write' }] })
}

/** Where a setting in force came from (D85, Q3): the workspace's own workspace.json, the node's buckle.env, or Buckle itself. */
export type SettingSource = 'workspace' | 'node' | 'built-in'

/** What Buckle holds where neither the workspace nor the node names a value. */
export const BUILT_IN_SETTINGS = Object.freeze({
  packs: Object.freeze({ enabled: null, shell: true, code: true, hostGit: false, hostLsp: false }),
  approvalWaitMs: DEFAULT_APPROVAL_WAIT_MS,
  browser: Object.freeze({ idleTimeoutMs: DEFAULT_BROWSER_IDLE_MS, headed: false }),
})

/** A workspace's settings in force, each with where it came from (resolveSettings). */
export interface ResolvedSettings {
  /** The policy in force, its lists resolved; where the folder shows is `mount`. */
  policy: WorkspacePolicy
  mount: string | null
  packs: { enabled: string[] | null; shell: boolean; code: boolean; hostGit: boolean; hostLsp: boolean }
  approvalWaitMs: number
  browser: { idleTimeoutMs: number; cdp?: string; profile?: string; args?: string; headed: boolean }
  env: Readonly<Record<string, string>>
  /** Each setting's source, by its key in workspace.json (`packs.shell`, `mount`, `policy.commands.allow`). */
  sources: Readonly<Record<string, SettingSource>>
}

/**
 * One workspace's settings in force (D85, Q3 and Q14): per key, the workspace's own value, else the node's, else
 * Buckle's built-in default. Its variables are the node's with its own set over them, key by key, and its lists are
 * resolved as resolvePolicy says.
 */
export function resolveSettings(stored: WorkspaceSettings, node: NodeDefaults): ResolvedSettings {
  const sources: Record<string, SettingSource> = {}
  const pick = <T>(key: string, own: T | undefined, nodeValue: T | undefined, builtIn: T): T => {
    sources[key] = own !== undefined ? 'workspace' : nodeValue !== undefined ? 'node' : 'built-in'
    return own !== undefined ? own : nodeValue !== undefined ? nodeValue : builtIn
  }
  const packs = {
    enabled: pick('packs.enabled', stored.packs.enabled, node.packs.enabled, BUILT_IN_SETTINGS.packs.enabled),
    shell: pick('packs.shell', stored.packs.shell, node.packs.shell, BUILT_IN_SETTINGS.packs.shell),
    code: pick('packs.code', stored.packs.code, node.packs.code, BUILT_IN_SETTINGS.packs.code),
    hostGit: pick('packs.hostGit', stored.packs.hostGit, node.packs.hostGit, BUILT_IN_SETTINGS.packs.hostGit),
    hostLsp: pick('packs.hostLsp', stored.packs.hostLsp, node.packs.hostLsp, BUILT_IN_SETTINGS.packs.hostLsp),
  }
  const browser = {
    idleTimeoutMs: pick('browser.idleTimeoutMs', stored.browser.idleTimeoutMs, undefined, BUILT_IN_SETTINGS.browser.idleTimeoutMs),
    ...defined('cdp', pick('browser.cdp', stored.browser.cdp, node.browser.cdp, undefined)),
    ...defined('profile', pick('browser.profile', stored.browser.profile, node.browser.profile, undefined)),
    ...defined('args', pick('browser.args', stored.browser.args, node.browser.args, undefined)),
    headed: pick('browser.headed', stored.browser.headed, node.browser.headed, BUILT_IN_SETTINGS.browser.headed),
  }
  return {
    policy: resolvePolicy(stored.policy, node.policy, sources),
    mount: pick('mount', ownMount(stored), node.mount, null),
    packs,
    approvalWaitMs: pick('approvalWaitMs', stored.approvalWaitMs, node.approvalWaitMs, BUILT_IN_SETTINGS.approvalWaitMs),
    browser,
    env: { ...node.env, ...stored.env },
    sources,
  }
}

/**
 * The policy in force (D85, Q14, "Fallback plus node deny floor"). Each allow-type list (command allow, interpreters,
 * approved URLs, allowed tools) is the workspace's own where it has one, else the node's, whole: a workspace with a list
 * of its own uses it alone. Each deny-type list (command deny, destructive, denied tools) is the node's with the
 * workspace's own added: a floor over every workspace that no workspace setting lifts. An empty list is no list, so a
 * list `buckle policy remove` or `clear` empties is the node's again; an allowed-tools list is the one that may be
 * empty, as it then allows no tool.
 */
function resolvePolicy(own: WorkspacePolicy, node: WorkspacePolicy, sources: Record<string, SettingSource>): WorkspacePolicy {
  const policy: WorkspacePolicy = { ...structuredClone(own), mount: null }
  const fallback = (key: string, mine: readonly string[], nodes: readonly string[], take: (list: string[]) => void) => {
    sources[key] = mine.length > 0 ? 'workspace' : nodes.length > 0 ? 'node' : 'built-in'
    if (mine.length === 0 && nodes.length > 0) take([...nodes])
  }
  fallback('policy.commands.allow', own.commands.allow, node.commands.allow, list => { policy.commands.allow = list })
  fallback('policy.commands.allowedInterpreters', allowedInterpreters(own), allowedInterpreters(node), list => { policy.commands.allowedInterpreters = list })
  fallback('policy.network.allow', own.network.allow, node.network.allow, list => { policy.network.allow = list })
  const ownTools = own.tools?.allow
  const nodeTools = node.tools?.allow
  sources['policy.tools.allow'] = ownTools !== undefined ? 'workspace' : nodeTools !== undefined ? 'node' : 'built-in'
  if (ownTools === undefined && nodeTools !== undefined) policy.tools = { allow: [...nodeTools], deny: policy.tools?.deny ?? [] }
  const floor = (key: string, nodes: readonly string[], mine: readonly string[]): string[] => {
    sources[key] = nodes.length > 0 ? 'node' : mine.length > 0 ? 'workspace' : 'built-in'
    return [...new Set([...nodes, ...mine])]
  }
  policy.commands.deny = floor('policy.commands.deny', node.commands.deny, own.commands.deny)
  const destructive = floor('policy.commands.destructive', destructivePatterns(node), destructivePatterns(own))
  if (destructive.length > 0 || own.commands.destructive !== undefined) policy.commands.destructive = destructive
  const toolDeny = floor('policy.tools.deny', node.tools?.deny ?? [], own.tools?.deny ?? [])
  if (toolDeny.length > 0) policy.tools = { ...(policy.tools?.allow === undefined ? {} : { allow: policy.tools.allow }), deny: toolDeny }
  return policy
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>
}

/** `<state>/workspaces/<id>/workspace.json`, for every workspace, workspace default included. */
export function settingsPath(nodeStateDirectory: string, workspaceId: string): string {
  return join(nodeStateDirectory, 'workspaces', workspaceId, 'workspace.json')
}

/** workspace.json will not parse. Its message names the file and the fields, never a value, so only the owner's routes show it. */
export class WorkspaceSettingsError extends Error implements ServiceFailure {
  readonly code = 'WORKSPACE_SETTINGS_UNREADABLE'
  readonly status = 409
}

/** Settings the node refuses, named by key and never by value. */
export class WorkspaceSettingsInvalidError extends Error implements ServiceFailure {
  readonly code = 'WORKSPACE_SETTINGS_INVALID'
  readonly status = 400
}

/** Another terminal wrote the file since it was read: the change is refused, never merged blind. */
export class WorkspaceSettingsConflictError extends Error implements ServiceFailure {
  readonly code = 'WORKSPACE_SETTINGS_CONFLICT'
  readonly status = 409
}

export interface SettingsFile {
  readonly filePath: string
  /** The settings as stored, or the defaults where no file exists yet. Throws WorkspaceSettingsError. */
  read(): WorkspaceSettings
  /** The file's identity and size and time (fileVersion): a cheap check, per call, for a write from another process. */
  version(): string
  /** Validates the next settings whole, then writes them with the revision counted on; refused when `expectedRevision` is stale. */
  update(change: (current: WorkspaceSettings) => WorkspaceSettings, expectedRevision?: number): Promise<WorkspaceSettings>
  /**
   * Migration's write: the settings as the node enforced them, checked for shape alone, so a stored pattern a later
   * grammar refuses is kept for `buckle policy remove` to repair rather than stopping the move.
   */
  migrate(settings: WorkspaceSettings): Promise<void>
}

export function openSettingsFile(input: { filePath: string; fallback?: () => WorkspaceSettings; lockDeadlineMs?: number }): SettingsFile {
  const fallback = input.fallback ?? defaultSettings
  const store = createJsonFileStore({ filePath: input.filePath, schema: WorkspaceSettingsSchema, fallback: fallback(), lockDeadlineMs: input.lockDeadlineMs })
  const readable = <R>(read: () => R): R => {
    try { return read() } catch (error) {
      if (error instanceof StateFileError) throw new WorkspaceSettingsError(error.message)
      throw error
    }
  }
  return {
    filePath: input.filePath,
    read: () => readable(() => store.read()),
    version: () => fileVersion(input.filePath),
    async update(change, expectedRevision) {
      mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 })
      return store.update((state) => {
        if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new WorkspaceSettingsConflictError('Workspace settings changed since they were read; read them again before saving')
        const next = WorkspaceSettingsSchema.parse({ ...change(structuredClone(state)), revision: state.revision + 1, updatedAt: new Date().toISOString() })
        // A bad pattern or browser setting never lands: the whole policy compiles, and the browser settings pass, before they are written.
        compilePolicy(next.policy)
        const refusal = browserSettingsRefusal(next.browser)
        if (refusal) throw new WorkspaceSettingsInvalidError(refusal)
        // A key the change took out is unset now (D85, Q3), so it leaves the file rather than keep its old value.
        for (const key of Object.keys(state)) if (!(key in next)) delete (state as Record<string, unknown>)[key]
        Object.assign(state, next)
        return next
      }).catch((error: unknown) => {
        if (error instanceof StateFileError) throw new WorkspaceSettingsError(error.message)
        throw error
      })
    },
    async migrate(settings) {
      mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 })
      await store.write(WorkspaceSettingsSchema.parse({ ...settings, revision: 1, updatedAt: new Date().toISOString() }))
    },
  }
}

/** What a workspace's runtime takes from its settings in force (workspaceConfig): its own, else the node's (resolveSettings). */
export function scopeOf(settings: WorkspaceSettings, node: NodeDefaults): Pick<WorkspaceScope, 'mount' | 'policy' | 'packs' | 'approvalWaitMs' | 'env'> {
  const resolved = resolveSettings(settings, node)
  return { mount: resolved.mount, policy: resolved.policy, packs: resolved.packs, approvalWaitMs: resolved.approvalWaitMs, env: resolved.env }
}

/** Where the workspace's own settings show its folder: a path, null for its real path, or undefined where the node's says. */
export function ownMount(settings: WorkspaceSettings): string | null | undefined {
  return settings.mounts === undefined ? undefined : settings.mounts.find(entry => entry.kind === 'workspace')?.target ?? null
}

/** A policy back as the workspace's own: its lists alone, as where the folder shows is `mounts`' to say (withMount). */
export function withPolicy(settings: WorkspaceSettings, policy: WorkspacePolicy): WorkspaceSettings {
  return { ...settings, policy: { ...policy, mount: null } }
}

/** Where the folder shows, as the workspace's own: a path, null for its real path, or undefined to take the node's again. */
export function withMount(settings: WorkspaceSettings, mount: string | null | undefined): WorkspaceSettings {
  const { mounts: _dropped, ...rest } = settings
  if (mount === undefined) return rest
  return { ...rest, mounts: mount === null ? [] : [{ kind: 'workspace' as const, target: mount, access: 'write' as const }] }
}
