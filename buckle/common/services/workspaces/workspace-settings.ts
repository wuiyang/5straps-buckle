import { mkdirSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { emptyWorkspacePolicy, MountPathSchema, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore, fileVersion, StateFileError } from '../../adapters/json-file-store.js'
import { isSecretName } from '../../domain/environment.js'
import { compilePolicy, PolicyError } from '../../domain/policy.js'
import { DEFAULT_APPROVAL_WAIT_MS, parseApprovalTimeout, parseBrowserSettings, parseList, policyFromEnvironment, type WorkspaceScope } from '../../runtime/config.js'
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
 * Why a workspace variable may not have this name, or null (Q13): a name that looks like a credential is refused, as no
 * secret reaches a command Buckle runs; credentials stay in the owner's own secret handling.
 */
export function variableNameRefusal(name: string): string | null {
  if (!VARIABLE_NAME.test(name)) return `${name} is not a variable name: letters, digits and underscores, not starting with a digit`
  if (isSecretName(name) || KEY_WORD.test(name)) return `${name} looks like a credential (a token, secret, password, or key), and no secret reaches a command Buckle runs: keep it in your own secret store, not in workspace settings`
  if (name.toUpperCase().startsWith('BUCKLE_')) return `${name} names a Buckle setting, which a workspace variable cannot set`
  if (RESERVED_VARIABLES.has(name.toUpperCase())) return `${name} is set by Buckle for every command, not by a workspace`
  return null
}

const PACK_IDS = BUILTIN_PACKS.map(pack => pack.id)

const PacksSchema = z.object({
  /** Null offers every built-in pack and plugins; a list offers those packs alone, and no plugins. */
  enabled: z.array(z.string().refine(id => PACK_IDS.includes(id), { error: issue => `Unknown pack ${String(issue.input)}; packs: ${PACK_IDS.join(', ')}` })).min(1).nullable().default(null),
  shell: z.boolean().default(true),
  code: z.boolean().default(true),
  hostGit: z.boolean().default(false),
  hostLsp: z.boolean().default(false),
}).strict()

/** Settings names in a refusal, in place of the environment variables the shared checks name (parseBrowserSettings). */
const BROWSER_KEYS: ReadonlyArray<[string, string]> = [['BUCKLE_BROWSER_CDP', 'browser.cdp'], ['BUCKLE_BROWSER_PROFILE', 'browser.profile'], ['BUCKLE_BROWSER_ARGS', 'browser.args'], ['BUCKLE_BROWSER_HEADED', 'browser.headed']]

/**
 * Stored, from migration, and checked at each write (browserSettingsRefusal); the browser pack reads them per workspace
 * in the mount and browser phase (Q10), and `buckle workspace set` changes them from then; until then the node's own
 * browser settings drive it.
 */
const BrowserSchema = z.object({
  idleTimeoutMs: z.number().int().min(BROWSER_IDLE_BOUNDS.min).max(BROWSER_IDLE_BOUNDS.max).default(DEFAULT_BROWSER_IDLE_MS),
  cdp: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  args: z.string().min(1).optional(),
  headed: z.boolean().default(false),
}).strict()

/**
 * Why the browser settings are refused on this platform, or null: the checks the node's own settings meet (an attached
 * browser beside a profile, arguments, or a window; a profile that is no absolute path; arguments Buckle refuses),
 * naming the settings and never a value.
 */
export function browserSettingsRefusal(browser: WorkspaceSettings['browser'], platform: NodeJS.Platform = process.platform): string | null {
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
 * The policy lists alone: where the folder shows lives in `mounts`, so one place says it. Patterns are compiled at each
 * write (openSettingsFile), not at each read, so a stored entry a later grammar refuses still reads and can be removed
 * with `buckle policy remove` (StoredPolicyError).
 */
const SettingsPolicySchema = WorkspacePolicySchema.refine(policy => policy.mount === null, { message: 'policy.mount is not stored here; the workspace mount in mounts says where the folder shows', path: ['mount'] })

/**
 * One workspace's settings (D83, the workspace-model brief item 2): written by the owner's CLI alone, through the
 * locked store, and read by a running node at each call (Q2). It holds no credential, so `buckle workspace show`
 * prints it whole.
 */
export const WorkspaceSettingsSchema = z.object({
  version: z.literal(1),
  /** Counts the writes, so a change made from two terminals at once is refused rather than lost. */
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.iso.datetime().nullable().default(null),
  policy: SettingsPolicySchema.default(emptyWorkspacePolicy),
  mounts: z.array(MountSchema).max(1).default(() => [{ kind: 'workspace' as const, target: WORKSPACE_MOUNT_TARGET, access: 'write' as const }]),
  env: EnvironmentSchema.default({}),
  packs: PacksSchema.default(() => PacksSchema.parse({})),
  browser: BrowserSchema.default(() => BrowserSchema.parse({})),
  /** Milliseconds a gated call is held for an answer when its caller sends no wait of its own; 0 holds it until someone answers. */
  approvalWaitMs: z.number().int().min(0).max(2_147_483_647).default(DEFAULT_APPROVAL_WAIT_MS),
}).strict()
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>

/** A new workspace's settings: every built-in pack, the shell and code mode on, host Git and language servers off, the folder at /workspace. */
export function defaultSettings(): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse({ version: 1 })
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

/** What a workspace's runtime takes from its settings (workspaceConfig). */
export function scopeOf(settings: WorkspaceSettings): Pick<WorkspaceScope, 'mount' | 'policy' | 'packs' | 'approvalWaitMs'> {
  const mount = settings.mounts.find(entry => entry.kind === 'workspace')
  return { mount: mount?.target ?? null, policy: settings.policy, packs: settings.packs, approvalWaitMs: settings.approvalWaitMs }
}

/** The policy and the mount a runtime holds, back as settings: the mount moves to `mounts`, where it is stored. */
export function withPolicy(settings: WorkspaceSettings, policy: WorkspacePolicy): WorkspaceSettings {
  const mounts = policy.mount === null ? [] : [{ kind: 'workspace' as const, target: policy.mount, access: 'write' as const }]
  return { ...settings, policy: { ...policy, mount: null }, mounts }
}

/**
 * The settings a node set up before the workspace model kept in its environment, as one workspace's (Q14): its policy
 * lists, its mount, its packs, its approval wait, and its browser. Migration input, and the test seam: a test describes
 * a workspace the way a 0.1 node's environment did.
 */
export function settingsFromEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): WorkspaceSettings {
  const policy = policyFromEnvironment(environment)
  const browser = parseBrowserSettings(environment, platform)
  const approvalWait = parseApprovalTimeout(environment.BUCKLE_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_WAIT_MS)
  return WorkspaceSettingsSchema.parse({
    version: 1,
    policy: { ...policy, mount: null },
    mounts: policy.mount === null ? [] : [{ kind: 'workspace', target: policy.mount, access: 'write' }],
    packs: {
      enabled: environment.BUCKLE_PACKS ? parseList(environment.BUCKLE_PACKS) : null,
      shell: environment.BUCKLE_ALLOW_SHELL !== 'false',
      code: environment.BUCKLE_ALLOW_CODE !== 'false',
      hostGit: environment.BUCKLE_ALLOW_HOST_GIT === 'true',
      hostLsp: environment.BUCKLE_ALLOW_HOST_LSP === 'true',
    },
    browser: { ...(browser.browserCdp ? { cdp: browser.browserCdp } : {}), ...(browser.browserProfile ? { profile: browser.browserProfile } : {}), ...(browser.browserArgs ? { args: browser.browserArgs } : {}), headed: environment.BUCKLE_BROWSER_HEADED === 'true' },
    approvalWaitMs: approvalWait ?? 0,
  })
}
