import { mkdirSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { allowedInterpreters, CommandPolicySchema, destructivePatterns, emptyWorkspacePolicy, MountPathSchema, NetworkPolicySchema, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore, fileVersion, StateFileError } from '../../adapters/json-file-store.js'
import { isSecretName } from '../../domain/environment.js'
import { referencePathRefusal } from '../../domain/secret-reference.js'
import { MAX_OWNER_MOUNTS, mountTargetRefusal, type MountRow, type OwnerMount, type TableMount } from '../../domain/mount-table.js'
import { comparablePath, ignoresCase, isInside, pathRoot } from '../../domain/paths.js'
import { compilePolicy, PolicyError } from '../../domain/policy.js'
import { browserBlockRefusal, DEFAULT_APPROVAL_WAIT_MS, type BrowserSettingNames, type NodeDefaults, type WorkspaceScope } from '../../runtime/config.js'
import { compileCommandGlob } from '../../domain/command-glob.js'
import { JUDGE_MODEL_NAME, JUDGE_MODES, JUDGE_PROVIDERS, type JudgeMode, type JudgeProvider } from '../../types/ports/judge.js'
import { QUICK_JUDGE_PROVIDERS, QUICK_JUDGE_SCOPES, type QuickJudgeProvider, type QuickJudgeScope } from '../../types/ports/quick-judge.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { BUILTIN_PACKS } from '../packs/index.js'
import { DEFAULT_IDLE_TIMEOUT_MS } from '../packs/browser/mode.js'
import { BUILT_IN_DELETE_POLICY, DELETE_IN_WORKSPACE_MODES, MAX_MASS_DELETE_LIMIT, type DeleteInWorkspace } from '../../domain/delete-policy.js'

/** The browser's idle timeout when a workspace names none, and its bounds (Q10 of the workspace-model brief): 60 s to 24 h. */
export const DEFAULT_BROWSER_IDLE_MS = DEFAULT_IDLE_TIMEOUT_MS
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
  if (RESERVED_VARIABLES.has(name.toUpperCase())) return `${name} is passed to every command by Buckle, not set by a workspace`
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
 * Its shell (Phase 2 item 4): `network` lets a command reach the network while no approved list is set; `isolation` runs
 * each command on a private copy of the folder.
 */
const ShellSchema = z.object({
  network: z.boolean().optional(),
  isolation: z.boolean().optional(),
}).strict()

/**
 * The commands the decision AI rates on their command line alone (D91, addendum D): the project's own tooling, whose
 * code is its dependencies', so no file is read for them. `npm run dev` runs whatever package.json names: the owner's
 * call, which is why the list is the owner's to change or empty.
 */
export const STANDARD_SCRIPTS: readonly string[] = Object.freeze([
  'npm run *', 'npm test', 'npm start', 'pnpm run *', 'pnpm dev', 'pnpm build', 'pnpm test', 'yarn run *', 'yarn dev', 'yarn build', 'yarn test',
  'bun run *', 'npx tsc *', 'npx vitest *', 'npx eslint *', 'npx prettier *', 'pnpx tsc *', 'pnpx vitest *', 'bunx tsc *', 'bunx vitest *',
])

/** A standard-scripts entry: a command glob in the allow list's syntax, refused where it does not compile. */
const StandardScriptSchema = z.string().min(1).max(1_000).refine((glob) => {
  try { compileCommandGlob(glob); return true } catch { return false }
}, { message: 'not a command glob Buckle reads' })

/**
 * Its decision AI (D91): `judge` says when it rates an interpreter call (off, on-request, or automated), `judgeProvider`
 * and `judgeModel` which model rates it (Buckle's own: an OpenAI-compatible endpoint and gpt-6-luna), and `judgeStandardScripts` the commands rated on
 * their command line alone; `quickJudge` which calls the optional quick stage rates (off, interpreters, asks, or all),
 * with `quickJudgeProvider` and `quickJudgeModel` (Buckle's own: TypeSafe's jev-latest). None holds a credential: the
 * keys and base URLs are the node's alone.
 */
const ApprovalSchema = z.object({
  judge: z.enum(JUDGE_MODES).optional(),
  judgeProvider: z.enum(JUDGE_PROVIDERS).optional(),
  judgeModel: z.string().regex(JUDGE_MODEL_NAME).optional(),
  judgeStandardScripts: z.array(StandardScriptSchema).max(200).optional(),
  quickJudge: z.enum(QUICK_JUDGE_SCOPES).optional(),
  quickJudgeProvider: z.enum(QUICK_JUDGE_PROVIDERS).optional(),
  quickJudgeModel: z.string().regex(JUDGE_MODEL_NAME).optional(),
}).strict()

/**
 * Its file tools' delete policy (the delete policy brief): `deleteInWorkspace` says whether a delete inside its own folder
 * runs under the write gate (allow) or asks at the destructive floor (ask); `massDeleteLimit` how many entries one call
 * may remove there before it asks anyway, 0 for no limit. Absent from a file that sets none, so a workspace.json written
 * before it reads as it did.
 */
const FilesSchema = z.object({
  deleteInWorkspace: z.enum(DELETE_IN_WORKSPACE_MODES).optional(),
  massDeleteLimit: z.number().int().min(0).max(MAX_MASS_DELETE_LIMIT).optional(),
}).strict()

/** The most files secrets.files may list. */
export const MAX_LISTED_SECRET_FILES = 64

/**
 * Its secret references (docs/secrets.md): `enabled` says whether Buckle reads them at all, on where unset; `files`
 * lists the files, by their paths relative to the folder as a reference writes them, whose use needs no ask. Absent from
 * a file that sets none, so a workspace.json written before it reads as it did.
 */
const SecretsSchema = z.object({
  enabled: z.boolean().optional(),
  files: z.array(z.string().superRefine((path, context) => {
    const refusal = referencePathRefusal(path)
    if (refusal) context.addIssue({ code: 'custom', message: `secrets.files: ${refusal}` })
  })).max(MAX_LISTED_SECRET_FILES).optional(),
}).strict()

/**
 * The workspace's browser (Phase 2 item 6, Q10): checked at each write (browserSettingsRefusal, and with the node's
 * defaults, browserInForceRefusal), and again where its browser pack chooses the browser, so a hand edit passes nothing
 * a write would not; each the workspace's own, else the node's (BUCKLE_BROWSER_CDP, BUCKLE_BROWSER_PROFILE,
 * BUCKLE_BROWSER_ARGS, and BUCKLE_BROWSER_HEADED), else Buckle's, the mode resolved as one unit (resolveSettings). A
 * profile folder or an attached Chrome belongs to one workspace at a time (the workspace manager's browserHeldBy).
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
  return browserBlockRefusal(browser, platform, WORKSPACE_BROWSER_NAMES)
}

/** The browser settings by their keys in workspace.json. */
const WORKSPACE_BROWSER_NAMES: BrowserSettingNames = Object.freeze(Object.fromEntries(BROWSER_KEYS.map(([variable, key]) => [key.slice('browser.'.length), key]))) as unknown as BrowserSettingNames

/**
 * How a refusal of the browser block in force names each setting: the workspace's own by its key in workspace.json,
 * the node's by its variable in buckle.env, so the owner reads which file to change.
 */
export function browserSettingNames(sources: Readonly<Record<string, SettingSource>>): BrowserSettingNames {
  const name = (key: keyof BrowserSettingNames, variable: string) => (sources[`browser.${key}`] === 'node' ? variable : `browser.${key}`)
  return { cdp: name('cdp', 'BUCKLE_BROWSER_CDP'), profile: name('profile', 'BUCKLE_BROWSER_PROFILE'), args: name('args', 'BUCKLE_BROWSER_ARGS'), headed: name('headed', 'BUCKLE_BROWSER_HEADED') }
}

/**
 * Why the browser block in force is refused, or null (browserBlockRefusal on what resolveSettings resolved), naming
 * each setting by its layer: a workspace setting only args or headed over the node's BUCKLE_BROWSER_CDP is refused here,
 * as the node refuses the two in one buckle.env.
 */
export function browserInForceRefusal(resolved: Pick<ResolvedSettings, 'browser' | 'sources'>, platform: NodeJS.Platform = process.platform): string | null {
  return browserBlockRefusal(resolved.browser, platform, browserSettingNames(resolved.sources))
}

/**
 * The workspace's folder in the agent's view: where it shows, read and write. `write` is how the first workspace.json
 * spelled `rw`, read as it.
 */
const FolderMountSchema = z.object({
  kind: z.literal('workspace'),
  target: MountPathSchema,
  access: z.enum(['rw', 'write']).transform((): 'rw' => 'rw'),
}).strict().superRefine((mount, context) => {
  try { compilePolicy({ ...emptyWorkspacePolicy(), mount: mount.target }) } catch (error) {
    if (error instanceof PolicyError) context.addIssue({ code: 'custom', message: error.message })
    else throw error
  }
})

/**
 * One of the owner's mounts (D84 (3), D85 Q6), as `buckle workspace mount add` stores it: the source as the disk names
 * it, checked against the disk when it is added, and here for its shape.
 */
const OwnerMountSchema = z.object({
  source: z.string().min(1).max(4096).refine(source => !/[\0\r\n]/.test(source) && pathRoot(source) !== '', 'A mount source is an absolute path'),
  target: z.string().min(1).max(4096),
  access: z.enum(['rw', 'ro']),
}).strict()

/**
 * The mount table (Phase 2 item 1): the folder's own entry and the owner's mounts. System folders are bound for every
 * workspace and never listed (D85, Q1). An owner's mount needs the folder mounted, as its target is a path in the
 * sandbox's own tree; no two targets overlap, nor two sources, and no target stands on a folder the sandbox keeps.
 */
const MountsSchema = z.array(z.union([FolderMountSchema, OwnerMountSchema])).max(MAX_OWNER_MOUNTS + 1).superRefine((mounts, context) => {
  const folders = mounts.filter(entry => 'kind' in entry)
  if (folders.length > 1) context.addIssue({ code: 'custom', message: 'The mount table holds one entry for the workspace\'s folder' })
  const owners = mounts.filter((entry): entry is OwnerMount => !('kind' in entry))
  const folder = folders[0]?.target ?? null
  if (owners.length > 0 && folder === null) context.addIssue({ code: 'custom', message: 'A mount needs the workspace\'s folder mounted, such as at /workspace: set mount first' })
  const caseless = ignoresCase()
  owners.forEach((mount, index) => {
    const refusal = mountTargetRefusal(mount.target, { folder, others: owners.slice(0, index).map(other => other.target) })
    if (refusal) context.addIssue({ code: 'custom', message: refusal, path: [mounts.indexOf(mount), 'target'] })
    const shared = owners.slice(0, index).find(other => sourcesOverlap(other.source, mount.source, caseless))
    if (shared) context.addIssue({ code: 'custom', message: `The source of the mount at ${mount.target} overlaps the source of the one at ${shared.target}`, path: [mounts.indexOf(mount), 'source'] })
  })
})

function sourcesOverlap(left: string, right: string, caseless: boolean): boolean {
  const [one, other] = [comparablePath(left, caseless), comparablePath(right, caseless)]
  return isInside(one, other) || isInside(other, one)
}

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
  /**
   * The mount table: where the folder shows (one entry, or none for its real path), and the owner's mounts. Absent, the
   * node's BUCKLE_WORKSPACE_MOUNT says where the folder shows; with no mount of its own, the node's mounts are its own.
   */
  mounts: MountsSchema.optional(),
  /** Its own variables, over the node's key by key. */
  env: EnvironmentSchema.default({}),
  packs: PacksSchema.default({}),
  shell: ShellSchema.default({}),
  browser: BrowserSchema.default({}),
  approval: ApprovalSchema.default({}),
  secrets: SecretsSchema.optional(),
  files: FilesSchema.optional(),
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
  return WorkspaceSettingsSchema.parse({ version: 1, mounts: [{ kind: 'workspace', target: WORKSPACE_MOUNT_TARGET, access: 'rw' }] })
}

/** Where a setting in force came from (D85, Q3): the workspace's own workspace.json, the node's buckle.env, or Buckle itself. */
export type SettingSource = 'workspace' | 'node' | 'built-in'

/** What Buckle holds where neither the workspace nor the node names a value. */
export const BUILT_IN_SETTINGS = Object.freeze({
  packs: Object.freeze({ enabled: null, shell: true, code: true, hostGit: false, hostLsp: false }),
  approvalWaitMs: DEFAULT_APPROVAL_WAIT_MS,
  shell: Object.freeze({ network: false, isolation: true }),
  browser: Object.freeze({ idleTimeoutMs: DEFAULT_BROWSER_IDLE_MS, headed: false }),
  approval: Object.freeze({ judge: 'off' as JudgeMode, judgeProvider: 'openai-compatible' as JudgeProvider, judgeModel: 'gpt-6-luna', judgeStandardScripts: STANDARD_SCRIPTS, quickJudge: 'off' as QuickJudgeScope, quickJudgeProvider: 'typesafe' as QuickJudgeProvider, quickJudgeModel: 'jev-latest' }),
  secrets: Object.freeze({ enabled: true, files: Object.freeze([] as string[]) }),
  files: Object.freeze({ deleteInWorkspace: BUILT_IN_DELETE_POLICY.inWorkspace, massDeleteLimit: BUILT_IN_DELETE_POLICY.massLimit }),
})

/** A workspace's settings in force, each with where it came from (resolveSettings). */
export interface ResolvedSettings {
  /** The policy in force, its lists resolved; where the folder shows is `mount`. */
  policy: WorkspacePolicy
  mount: string | null
  /** The owner's mounts in force: the workspace's own, else the node's (BUCKLE_MOUNTS, and BUCKLE_SCRATCH_ROOTS as scratch). */
  mounts: readonly TableMount[]
  packs: { enabled: string[] | null; shell: boolean; code: boolean; hostGit: boolean; hostLsp: boolean }
  approvalWaitMs: number
  shell: { network: boolean; isolation: boolean }
  browser: { idleTimeoutMs: number; cdp?: string; profile?: string; args?: string; headed: boolean }
  approval: ResolvedApproval
  /** Its secret references (docs/secrets.md): the workspace's own alone, else Buckle's; the node names none. */
  secrets: { enabled: boolean; files: readonly string[] }
  /** Its file tools' delete policy (the delete policy brief): the workspace's own, else the node's, else Buckle's. */
  files: { deleteInWorkspace: DeleteInWorkspace; massDeleteLimit: number }
  env: Readonly<Record<string, string>>
  /** Each setting's source, by its key in workspace.json (`packs.shell`, `mount`, `policy.commands.allow`). */
  sources: Readonly<Record<string, SettingSource>>
}

/** A workspace's decision AI in force (D91): Buckle's own provider and model stand where neither the workspace nor the node names one. */
export interface ResolvedApproval {
  judge: JudgeMode
  judgeProvider: JudgeProvider
  judgeModel: string
  judgeStandardScripts: readonly string[]
  quickJudge: QuickJudgeScope
  quickJudgeProvider: QuickJudgeProvider
  quickJudgeModel: string
}

/** A deny-type list in force, entry by entry: the node's floor, and the workspace's own beside it. */
export interface FloorEntries { node: string[]; workspace: string[] }

/**
 * Where each part of the policy in force comes from (D85, Q3 and Q14), as `buckle policy show` and the setup face name
 * it: each allow-type list and the mount whole, and each deny-type list entry by entry, the node's entries its floor.
 */
export interface PolicySources {
  mount: SettingSource
  'commands.allow': SettingSource
  'commands.allowedInterpreters': SettingSource
  'network.allow': SettingSource
  'tools.allow': SettingSource
  'commands.deny': FloorEntries
  'commands.destructive': FloorEntries
  'tools.deny': FloorEntries
}

/** The policy's sources, from the workspace's own settings and the node's defaults, as resolveSettings reads them. */
export function policySources(stored: WorkspaceSettings, node: NodeDefaults): PolicySources {
  const { sources } = resolveSettings(stored, node)
  const floor = (nodes: readonly string[], mine: readonly string[]): FloorEntries => ({ node: [...new Set(nodes)], workspace: [...new Set(mine)].filter(entry => !nodes.includes(entry)) })
  return {
    mount: sources.mount!,
    'commands.allow': sources['policy.commands.allow']!,
    'commands.allowedInterpreters': sources['policy.commands.allowedInterpreters']!,
    'network.allow': sources['policy.network.allow']!,
    'tools.allow': sources['policy.tools.allow']!,
    'commands.deny': floor(node.policy.commands.deny, stored.policy.commands.deny),
    'commands.destructive': floor(destructivePatterns(node.policy), destructivePatterns(stored.policy)),
    'tools.deny': floor(node.policy.tools?.deny ?? [], stored.policy.tools?.deny ?? []),
  }
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
  // The browser's mode is one unit (finding 8 of the third re-check): a workspace that names an attached Chrome or a
  // profile folder of its own takes both from itself, never the node's other one, and under an attached Chrome neither
  // the node's arguments nor its window apply, as the Chrome keeps its owner's.
  const ownMode = stored.browser.cdp !== undefined || stored.browser.profile !== undefined
  const cdp = pick('browser.cdp', stored.browser.cdp, ownMode ? undefined : node.browser.cdp, undefined)
  const profile = pick('browser.profile', stored.browser.profile, ownMode ? undefined : node.browser.profile, undefined)
  const attached = cdp !== undefined
  const browser = {
    idleTimeoutMs: pick('browser.idleTimeoutMs', stored.browser.idleTimeoutMs, undefined, BUILT_IN_SETTINGS.browser.idleTimeoutMs),
    ...defined('cdp', cdp),
    ...defined('profile', profile),
    ...defined('args', pick('browser.args', stored.browser.args, attached ? undefined : node.browser.args, undefined)),
    headed: pick('browser.headed', stored.browser.headed, attached ? undefined : node.browser.headed, BUILT_IN_SETTINGS.browser.headed),
  }
  return {
    policy: resolvePolicy(stored.policy, node.policy, sources),
    mount: pick('mount', ownMount(stored), node.mount, null),
    mounts: mountsInForce(stored, node, sources),
    packs,
    approvalWaitMs: pick('approvalWaitMs', stored.approvalWaitMs, node.approvalWaitMs, BUILT_IN_SETTINGS.approvalWaitMs),
    shell: {
      network: pick('shell.network', stored.shell.network, node.shell.network, BUILT_IN_SETTINGS.shell.network),
      isolation: pick('shell.isolation', stored.shell.isolation, node.shell.isolation, BUILT_IN_SETTINGS.shell.isolation),
    },
    browser,
    approval: {
      judge: pick('approval.judge', stored.approval.judge, node.approval.judge, BUILT_IN_SETTINGS.approval.judge),
      judgeProvider: pick('approval.judgeProvider', stored.approval.judgeProvider, node.approval.judgeProvider, BUILT_IN_SETTINGS.approval.judgeProvider),
      judgeModel: pick('approval.judgeModel', stored.approval.judgeModel, node.approval.judgeModel, BUILT_IN_SETTINGS.approval.judgeModel),
      judgeStandardScripts: pick('approval.judgeStandardScripts', stored.approval.judgeStandardScripts, node.approval.judgeStandardScripts, BUILT_IN_SETTINGS.approval.judgeStandardScripts),
      quickJudge: pick('approval.quickJudge', stored.approval.quickJudge, node.approval.quickJudge, BUILT_IN_SETTINGS.approval.quickJudge),
      quickJudgeProvider: pick('approval.quickJudgeProvider', stored.approval.quickJudgeProvider, undefined, BUILT_IN_SETTINGS.approval.quickJudgeProvider),
      quickJudgeModel: pick('approval.quickJudgeModel', stored.approval.quickJudgeModel, node.approval.quickJudgeModel, BUILT_IN_SETTINGS.approval.quickJudgeModel),
    },
    secrets: {
      enabled: pick('secrets.enabled', stored.secrets?.enabled, undefined, BUILT_IN_SETTINGS.secrets.enabled),
      files: pick('secrets.files', stored.secrets?.files, undefined, BUILT_IN_SETTINGS.secrets.files),
    },
    files: {
      deleteInWorkspace: pick('files.deleteInWorkspace', stored.files?.deleteInWorkspace, node.files.deleteInWorkspace, BUILT_IN_SETTINGS.files.deleteInWorkspace),
      massDeleteLimit: pick('files.massDeleteLimit', stored.files?.massDeleteLimit, node.files.massDeleteLimit, BUILT_IN_SETTINGS.files.massDeleteLimit),
    },
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

/**
 * The mounts in force, as an allow-type list resolves (D85, Q14): the workspace's own where it has any, else the node's
 * whole. A workspace whose table holds its folder alone has none of its own, so removing its last mount takes the
 * node's up again.
 */
function mountsInForce(stored: WorkspaceSettings, node: NodeDefaults, sources: Record<string, SettingSource>): TableMount[] {
  const own = ownerMounts(stored)
  const nodes = node.mounts ?? []
  sources.mounts = own.length > 0 ? 'workspace' : nodes.length > 0 ? 'node' : 'built-in'
  return (own.length > 0 ? own : nodes).map(mount => ({ ...mount }))
}

/**
 * The mount table in force as the owner reads it, the same wherever it is shown (`buckle workspace mount list`,
 * `buckle policy show`, the setup face's status, `buckle init`, and `buckle workspace init`): the folder's own entry
 * first, where it shows at a sandbox path, then each mount, the workspace's own or, while it has none, the node's
 * (BUCKLE_MOUNTS and BUCKLE_SCRATCH_ROOTS).
 * The system folders and the node's toolchains are bound for every workspace and are no row (D85, Q1; D90 (3)).
 */
export function mountRows(folder: string, resolved: Pick<ResolvedSettings, 'mount' | 'mounts' | 'sources'>): MountRow[] {
  const from = (entry: TableMount): MountRow['from'] => (entry.scratch ? 'node scratch root' : resolved.sources.mounts === 'node' ? 'node default' : 'workspace')
  return [
    ...(resolved.mount === null ? [] : [{ source: folder, target: resolved.mount, access: 'rw' as const, from: 'folder' as const }]),
    ...resolved.mounts.map(entry => ({ source: entry.source, target: entry.target, access: entry.access, from: from(entry) })),
  ]
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>
}

/** `<state>/workspaces/<id>/workspace.json`, for every workspace, the node folder's included. */
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
export function scopeOf(settings: WorkspaceSettings, node: NodeDefaults): Pick<WorkspaceScope, 'mount' | 'mounts' | 'policy' | 'packs' | 'approvalWaitMs' | 'shell' | 'browser' | 'approval' | 'secrets' | 'files' | 'env'> {
  const resolved = resolveSettings(settings, node)
  return { mount: resolved.mount, mounts: resolved.mounts, policy: resolved.policy, packs: resolved.packs, approvalWaitMs: resolved.approvalWaitMs, shell: resolved.shell, browser: { ...resolved.browser, names: browserSettingNames(resolved.sources) }, approval: resolved.approval, secrets: resolved.secrets, files: resolved.files, env: resolved.env }
}

/** Where the workspace's own settings show its folder: a path, null for its real path, or undefined where the node's says. */
export function ownMount(settings: WorkspaceSettings): string | null | undefined {
  return settings.mounts === undefined ? undefined : settings.mounts.find(entry => 'kind' in entry)?.target ?? null
}

/** A policy back as the workspace's own: its lists alone, as where the folder shows is `mounts`' to say (withMount). */
export function withPolicy(settings: WorkspaceSettings, policy: WorkspacePolicy): WorkspaceSettings {
  return { ...settings, policy: { ...policy, mount: null } }
}

/** The owner's mounts the workspace's own table holds, in order. */
export function ownerMounts(settings: WorkspaceSettings): OwnerMount[] {
  return (settings.mounts ?? []).filter((entry): entry is OwnerMount => !('kind' in entry)).map(mount => ({ ...mount }))
}

/**
 * Where the folder shows, as the workspace's own: a path, null for its real path, or undefined to take the node's again.
 * The owner's mounts stay; as they need the folder mounted, taking the mount away while it has any is refused.
 */
export function withMount(settings: WorkspaceSettings, mount: string | null | undefined): WorkspaceSettings {
  const { mounts: _dropped, ...rest } = settings
  const owners = ownerMounts(settings)
  if (mount === undefined || mount === null) {
    if (owners.length > 0) throw new WorkspaceSettingsInvalidError(`This workspace has ${owners.length} mount${owners.length === 1 ? '' : 's'} of its own, which need its folder mounted: remove ${owners.length === 1 ? 'it' : 'them'} first with buckle workspace mount remove <sandbox-path>`)
    if (mount === undefined) return rest
    return { ...rest, mounts: [] }
  }
  const clash = owners.map(owner => mountTargetRefusal(owner.target, { folder: mount, others: [] })).find(refusal => refusal !== null)
  if (clash) throw new WorkspaceSettingsInvalidError(`The folder cannot show at ${mount}: a mount of this workspace stands there (${clash})`)
  return { ...rest, mounts: [{ kind: 'workspace' as const, target: mount, access: 'rw' as const }, ...owners] }
}

/**
 * The owner's mounts as the workspace's own, beside its folder's entry; `folder` is where the folder shows in force,
 * written as the workspace's own where the table did not hold it, so a node's later change to BUCKLE_WORKSPACE_MOUNT
 * never moves the folder under the mounts. None leaves the folder's entry, so the node's mounts apply again.
 */
export function withOwnerMounts(settings: WorkspaceSettings, owners: readonly OwnerMount[], folder: string | null): WorkspaceSettings {
  const entry = (settings.mounts ?? []).find(item => 'kind' in item)
  const target = entry?.target ?? folder
  if (owners.length > 0 && target === null) throw new WorkspaceSettingsInvalidError('A mount needs the workspace\'s folder mounted, so the agent has a sandbox to see it in: buckle workspace set mount /workspace first')
  const folderEntry = target === null ? [] : [{ kind: 'workspace' as const, target, access: 'rw' as const }]
  if (owners.length === 0 && settings.mounts === undefined) return settings
  return { ...settings, mounts: [...folderEntry, ...owners.map(mount => ({ ...mount }))] }
}
