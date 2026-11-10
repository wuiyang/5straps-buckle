import { parseSandboxMounts } from '../domain/sandbox-mounts.js'
import type { TableMount } from '../domain/mount-table.js'
import type { SandboxBind } from '../types/ports/sandbox.js'
import { isAbsolute, join } from 'pathe'
import { emptyWorkspacePolicy, SandboxModeSchema, type WorkspacePolicy } from '@5straps/protocol'
import { approvalKey, type ApprovalKey } from '@5straps/protocol/envelope'
import { browserArgumentsRefusal } from '../domain/browser-arguments.js'
import { INTERPRETER_NAMES, isInterpreter } from '../domain/command-forms.js'
import { homeDirectory, ignoresCase, isDriveRoot, isInside, isInsideComparable, typedPath, WHOLE_DRIVE, workingDirectory } from '../domain/paths.js'
import { compileHostPattern, UrlPatternError } from '../domain/url-pattern.js'
import { compilePolicy, PolicyError } from '../domain/policy.js'
import { launchdGuardedPaths } from '../domain/launchd-agent.js'
import { systemdGuardedPaths } from '../domain/systemd-unit.js'
import { compileCommandGlob, CommandGlobError } from '../domain/command-glob.js'
import { JUDGE_MODEL_NAME, JUDGE_MODES, JUDGE_PROVIDERS, type JudgeMode, type JudgeProvider } from '../types/ports/judge.js'
import { QUICK_JUDGE_SCOPES, type QuickJudgeProvider, type QuickJudgeScope } from '../types/ports/quick-judge.js'
import { DEFAULT_MAX_TRANSFER_BYTES } from '../domain/file-transfer-limits.js'
import { parseList } from '../domain/comma-list.js'
import { MAX_MASS_DELETE_LIMIT, parseDeleteInWorkspace, parseMassDeleteLimit, type DeleteInWorkspace } from '../domain/delete-policy.js'
import { parseSessionIdle, SESSION_IDLE_BOUNDS } from '../domain/approval/session-idle.js'
import { recordedEnvironmentFiles } from './environment-files.js'
import { realPathOf } from './real-path.js'
import { cidrRefusal } from '../domain/ip.js'

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TIMEOUT_MS = 300_000
/** How long a gated call is held for an answer when the workspace names no wait of its own. */
export const DEFAULT_APPROVAL_WAIT_MS = 15_000
const DEFAULT_FORGE_API_URL = 'https://api.github.com'
const DEFAULT_FORGE_GIT_AUTHOR = '5straps agent <agent@5straps.local>'
const GIT_AUTHOR_PATTERN = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/

/**
 * The node's settings (Q3 of the workspace-model brief): what every workspace on the node shares. buckle.env holds them,
 * and a change needs a restart (BUCKLE-D19). Each workspace's own settings live in its workspace.json instead.
 */
export interface NodeConfig {
  host: string
  port: number
  serverId: string
  serverName: string
  description: string
  usage: string
  /**
   * BUCKLE_AUTH_TOKEN, the agent token of a node set up before the workspace model, as this process sees it: migration
   * hashes the file's into the node folder's workspace's tokens as `node` (MigrationInput) and takes it out of the file; a node
   * already moved warns that it is set. No request is checked against it, and pairing sends a workspace's own token.
   */
  authToken: string
  /**
   * The admin credential. It opens `/setup`, where the policy is read and pushed, mints and
   * revokes workspace tokens, and writes a persisted approval; the agent's token opens nothing
   * there. Empty leaves the setup face unmounted.
   */
  adminToken: string
  /**
   * Owner decision D8 of 2026-09-29: the admin HTTP layer (/setup and its /workspaces/<id>/ twins) is
   * experimental and served only when BUCKLE_EXPERIMENTAL_ADMIN_HTTP is true. Off, every route of it
   * answers the router's 404, admin credential or not. The local CLI never needs it.
   */
  experimentalAdminHttp: boolean
  /**
   * BUCKLE_WORKSPACE_ROOT as typed, where the environment the process was started with sets it, as an MCP config
   * written before the workspace model does: `buckle mcp`'s legacy pick. Never buckle.env's line, which migration alone
   * reads (fix brief 1, B; finding 1 of the Phase 1 review).
   */
  callerWorkspaceRoot?: string
  /** What a node set up before the workspace model kept for its folder, which migration reads once (MigrationInput). */
  migration: MigrationInput
  /** The workspace settings buckle.env names, which every workspace takes where its own workspace.json holds none (D85, Q3). */
  workspaceDefaults: NodeDefaults
  strictWrites: boolean
  sandboxMode: 'auto' | 'none' | 'bubblewrap' | 'seatbelt'
  acknowledgedUnsandboxed: boolean
  historyMaxBytes: number
  historyRetentionDays: number
  isolationMaxBytes: number
  environmentValidator?: string
  braveSearchApiKey?: string
  /**
   * The key the node asks the decision AI with (D91): the node's alone, never a workspace's, never printed, and never
   * passed to a program it runs. Absent, every workspace's judge stays off whatever approval.judge says.
   */
  judgeApiKey?: string
  /**
   * Where the OpenAI-compatible thorough stage is asked, for a gateway or a local model (D91, addenda A and 2 A): the
   * node's alone, read from its environment file alone (fix brief 1, item 17). Absent, https://api.openai.com/v1.
   */
  judgeBaseUrl?: string
  /**
   * The key the node asks Socket with about the third-party packages the decision AI is shown (D91, addendum 2 C), and
   * Socket's API root for a test: the node's alone, never a workspace's, never printed, never passed to a program it runs.
   * Absent, every package's Socket summary is null and the rating runs.
   */
  socketApiKey?: string
  socketBaseUrl?: string
  /**
   * The key and base URL the node asks the decision AI's quick stage with (D91, addendum 2 B): the node's alone. Absent
   * key, the quick stage stays off in every workspace whatever approval.quickJudge says.
   */
  quickJudgeApiKey?: string
  quickJudgeBaseUrl?: string
  /**
   * The owner's forge credential. Absent withholds the forge pack, naming the variable, rather
   * than failing partway through a commit-push-review sequence.
   */
  forgeGithubToken?: string
  /** The forge API root. Configurable so a test server and an Enterprise install take one path. */
  forgeApiUrl: string
  /** The identity forge commits carry, without writing anything into the workspace's git config. */
  forgeGitAuthor: { name: string; email: string }
  agentBrowserCommand: string
  /** Where to announce a pending approval, so a person can be reached away from the machine. */
  approvalWebhook?: string
  /**
   * Host directories still readable inside a mounted sandbox, for toolchains outside /usr: bound at their own path for
   * every workspace, beside the system folders, and never listed as a mount (D85, Q1).
   */
  mountReadOnlyPaths: string[]
  /** Where every refused call is posted as it happens. Rings, usually. */
  reportUrl?: string
  reportToken?: string
  /**
   * `RINGS-D20`: the key Rings minted at pairing. With it, approval decisions from Rings must
   * arrive sealed and reports to Rings go sealed; without it, both stay plain until a re-pair.
   */
  ringsApprovalKey?: ApprovalKey
  skillDirectories: string[]
  stateDirectory: string
  /**
   * The file the node takes its settings from (environmentFilePath), there or not: buckle.env in the state directory, or
   * the file BUCKLE_ENV_FILE names, which may lie outside it. Protected as the state directory is (protectedStateRoots).
   */
  environmentFile: string
  /**
   * The files outside the state directory that init, a service install, or a serve start recorded as the node's settings
   * (recordedEnvironmentFiles), protected with it in every process, whatever this one's environment names. A runtime
   * reads the record again as it opens and at each call's start, so one running takes up a file recorded since.
   */
  recordedEnvironmentFiles: string[]
  /** How long a state file update waits for another process's lock; the store's default when absent. Never read from the environment. */
  stateLockDeadlineMs?: number
  maxRequestBytes: number
  /** The largest file one `buckle cp` moves through PUT or GET /v1/files (BUCKLE_MAX_TRANSFER_BYTES), 100 MiB by default. */
  maxTransferBytes: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

/**
 * One workspace's runtime configuration: the node's settings with the workspace's own over them, from its registry
 * record and its workspace.json (workspaceConfig). `serverName` is the workspace's name.
 */
export interface BuckleConfig extends NodeConfig {
  history: { keepTurns: number; turnIdleMs: number; maxFileBytes: number }
  /** The workspace's id (D85, Q15): a UUID Buckle assigned, which its records are keyed by. */
  workspaceId: string
  cwd: string
  enabledPacks?: string[]
  allowHostGit: boolean
  allowHostLsp: boolean
  enableShell: boolean
  /** Code mode's code_run and code_api (owner decision D82). */
  allowCode: boolean
  /** The history pack's history_list and history_restore (slice D, rollback). */
  allowHistory: boolean
  /** How long a gated call is held for an answer, in milliseconds; null holds it until someone answers. */
  approvalTimeoutMs: number | null
  /** How long a session may go without activity of its own before it ends (approval.sessionIdleMs); 0 ends none at idle. */
  approvalSessionIdleMs: number
  /** The plain variables the workspace's settings give its shell commands (Q13); a call's own `env` is set over them. */
  commandEnvironment: Readonly<Record<string, string>>
  /** Whether Buckle reads the workspace's secret references (secrets.enabled, docs/user/how-to/secrets.md); on where absent. */
  secretsEnabled?: boolean
  /** The files whose use by a secret reference needs no ask (secrets.files), as a reference writes their paths; none where absent. */
  secretFiles?: readonly string[]
  /**
   * Its delete policy (the delete policy brief): whether a delete inside its own folder runs under the write gate or asks
   * at the destructive floor (files.deleteInWorkspace), and how many entries one call may remove there before it asks
   * anyway (files.massDeleteLimit, 0 for no limit).
   */
  deleteInWorkspace: DeleteInWorkspace
  massDeleteLimit: number
  /** The CIDR ranges its network egress reaches on private, loopback, or reserved addresses without asking (network.privateRanges). */
  networkPrivateRanges: readonly string[]
  /** The workspace's policy, from its workspace.json, with its mount's target as `mount`. */
  policy: WorkspacePolicy
  /** Its mount table in force (Phase 2 item 1): its own mounts, else the node's. */
  mounts: TableMount[]
  /** Whether its shell may reach the network while it has no approved list (shell.network; Phase 2 item 4). */
  shellNetwork: boolean
  /** Whether its shell runs on private copies of the folder (shell.isolation). */
  isolateShell: boolean
  /**
   * Its decision AI (D91): when it rates an unknown interpreter call or a script file run (approval.judge), the provider and model that rate it,
   * each with Buckle's built-in default (openai-compatible, gpt-6-luna), and the commands it rates on their command
   * line alone (approval.judgeStandardScripts).
   */
  approvalJudge: JudgeMode
  approvalJudgeProvider: JudgeProvider
  approvalJudgeModel: string
  approvalJudgeStandardScripts: readonly string[]
  /** Which calls the quick stage rates (approval.quickJudge), and the provider and model that rate them. */
  approvalQuickJudge: QuickJudgeScope
  approvalQuickJudgeProvider: QuickJudgeProvider
  approvalQuickJudgeModel: string
  /**
   * Its browser (Phase 2 item 6, Q10): the owner's own Chrome over its DevTools port (browser.cdp), a profile folder kept
   * across launches (browser.profile, as the disk names it), Chromium arguments for a browser Buckle launches
   * (browser.args), a visible window (browser.headed), and how long an idle browser lives (browser.idleTimeoutMs).
   */
  browserCdp?: string
  browserProfile?: string
  browserArgs?: string
  browserHeaded: boolean
  browserIdleTimeoutMs: number
  /** How a refusal of the browser settings in force names each: the workspace's own by its key; the variable when absent. */
  browserSettingNames?: BrowserSettingNames | undefined
  /** The node's own state directory, which holds the registry and every workspace's settings. */
  nodeStateDirectory?: string
  /** True for the workspace migration made of the node's own folder (D85, Q15): its face carries the node-wide readiness, and a node-level workbench grant opens here. */
  nodeFolder?: boolean
}

/**
 * Where a node's settings came from: its environment file, and the environment the process was started with, which
 * wins over the file for a node setting. Migration tells the two apart (MigrationInput).
 */
export interface EnvironmentLayers {
  /** buckle.env, or the file BUCKLE_ENV_FILE names, with its own BUCKLE_ values; null where the node has none. */
  file: { path: string; values: Readonly<Record<string, string>> } | null
  /** The environment the process was started with, before the file filled in what it left unset. */
  caller: NodeJS.ProcessEnv
  /**
   * Set by the process entry: every workspace's defaults come from the file alone, so a node with none has none, and a
   * shell's or an MCP config's env, which an agent may be able to write, never sets them (fix brief 4, finding 42). Left
   * unset, one environment stands for both, as a test or a caller building a config from values has it.
   */
  defaultsFromFileAlone?: boolean
}

/**
 * What migration reads, once (Q15): the environment file's own token and folder, never what a shell or an MCP config's
 * env set over them, so the first command after an upgrade cannot make its caller's token or folder the node's for good
 * (finding 34 of the Phase 1 review). A node with no file was configured by the environment it starts with, and that is
 * what migration reads there. The node's workspace settings stay in buckle.env as its defaults (D85, Q3), so migration
 * copies none of them.
 */
export interface MigrationInput {
  /** The environment file read, which migration takes BUCKLE_AUTH_TOKEN out of once it is hashed; null where none was. */
  file: string | null
  /** BUCKLE_AUTH_TOKEN, which becomes the node folder's workspace's token `node`. */
  authToken: string
  /** BUCKLE_WORKSPACE_ROOT as typed: the node folder's workspace's folder. */
  workspaceRoot?: string
  /** The keys the caller's own environment sets to another value than the file holds, which refuse the move. */
  conflicts: readonly string[]
  /**
   * The deny-type lists the caller's own environment sets to other entries than the file holds, which refuse the move
   * too (fix brief 4, finding 8): 0.1 enforced the caller's list, and the node reads the file's alone after it.
   */
  floorConflicts: readonly string[]
}

/** `platform`: the host's unless a test imitates another. `layers`: the file and the caller apart; one environment stands for both by default. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, layers: EnvironmentLayers = { file: null, caller: environment }): NodeConfig {
  const stateDirectory = stateDirectoryOf(environment, platform)
  const sandboxMode = parseSandboxMode(environment.BUCKLE_SANDBOX)
  const authToken = environment.BUCKLE_AUTH_TOKEN ?? ''
  const adminToken = environment.BUCKLE_ADMIN_TOKEN?.trim() ?? ''
  if (adminToken && adminToken === authToken) {
    throw new Error('BUCKLE_ADMIN_TOKEN must differ from BUCKLE_AUTH_TOKEN: the credential that configures the node is never the one an agent holds')
  }
  if (Boolean(environment.BUCKLE_REPORT_URL) !== Boolean(environment.BUCKLE_REPORT_TOKEN)) {
    throw new Error('BUCKLE_REPORT_URL and BUCKLE_REPORT_TOKEN must be configured together')
  }

  return {
    host: environment.BUCKLE_HOST ?? '127.0.0.1',
    port: parsePositiveInteger(environment.BUCKLE_PORT, 4320),
    serverId: environment.BUCKLE_SERVER_ID ?? 'local-dev',
    serverName: environment.BUCKLE_SERVER_NAME ?? 'Local Buckle',
    description: environment.BUCKLE_DESCRIPTION ?? '',
    usage: environment.BUCKLE_USAGE ?? '',
    authToken,
    adminToken,
    ...(layers.caller.BUCKLE_WORKSPACE_ROOT ? { callerWorkspaceRoot: typedPath(layers.caller.BUCKLE_WORKSPACE_ROOT, platform) } : {}),
    migration: migrationInput(environment, layers, platform),
    // From the environment file alone, where the node has one, as migration reads it (finding 34): a shell's or an MCP
    // config's env, which an agent may be able to write, never sets or lifts every workspace's defaults and deny floor,
    // and buckle mcp reads no file outside the state directory (refuseForeignEnvironmentFile; fix brief 4, finding 7).
    workspaceDefaults: nodeDefaultsFrom(layers.file?.values ?? (layers.defaultsFromFileAlone ? {} : environment), platform),
    strictWrites: environment.BUCKLE_STRICT_WRITES === 'true',
    sandboxMode,
    acknowledgedUnsandboxed: sandboxMode === 'none',
    historyMaxBytes: parsePositiveInteger(environment.BUCKLE_HISTORY_MAX_BYTES, 268_435_456),
    historyRetentionDays: parsePositiveInteger(environment.BUCKLE_HISTORY_RETENTION_DAYS, 30),
    experimentalAdminHttp: environment.BUCKLE_EXPERIMENTAL_ADMIN_HTTP === 'true',
    isolationMaxBytes: parsePositiveInteger(environment.BUCKLE_ISOLATION_MAX_BYTES, 268_435_456),
    environmentValidator: environment.BUCKLE_ENV_VALIDATOR_COMMAND || undefined,
    braveSearchApiKey: environment.BUCKLE_BRAVE_SEARCH_API_KEY || undefined,
    ...decisionAiEndpoints(layers.file?.values ?? (layers.defaultsFromFileAlone ? {} : environment)),
    forgeGithubToken: environment.BUCKLE_FORGE_GITHUB_TOKEN || undefined,
    forgeApiUrl: parseForgeApiUrl(environment.BUCKLE_FORGE_GITHUB_API_URL),
    forgeGitAuthor: parseGitAuthor(environment.BUCKLE_FORGE_GIT_AUTHOR),
    // Empty reads as unset, as the validator's setting does, so `buckle init` and the node look up the same program.
    agentBrowserCommand: environment.BUCKLE_AGENT_BROWSER_COMMAND || 'agent-browser',
    approvalWebhook: environment.BUCKLE_APPROVAL_WEBHOOK || undefined,
    mountReadOnlyPaths: parseList(environment.BUCKLE_MOUNT_READ_ONLY).map(path => typedPath(path, platform)),
    reportUrl: environment.BUCKLE_REPORT_URL || undefined,
    reportToken: environment.BUCKLE_REPORT_TOKEN || undefined,
    ringsApprovalKey: parseRingsApprovalKey(environment.BUCKLE_RINGS_APPROVAL_KEY),
    skillDirectories: parseList(environment.BUCKLE_SKILLS_DIRS),
    stateDirectory,
    environmentFile: environmentFilePath(environment, platform),
    recordedEnvironmentFiles: recordedEnvironmentFiles(stateDirectory),
    maxRequestBytes: parsePositiveInteger(environment.BUCKLE_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES),
    maxTransferBytes: parsePositiveInteger(environment.BUCKLE_MAX_TRANSFER_BYTES, DEFAULT_MAX_TRANSFER_BYTES),
    defaultTimeoutMs: parsePositiveInteger(environment.BUCKLE_DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: parsePositiveInteger(environment.BUCKLE_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS),
  }
}

/** The node settings that are every workspace's defaults (D85, Q3), which a node reads from its environment file alone. */
export const WORKSPACE_DEFAULT_KEYS: readonly string[] = Object.freeze([
  'BUCKLE_COMMAND_ALLOW', 'BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE', 'BUCKLE_ALLOWED_INTERPRETERS', 'BUCKLE_NETWORK_ALLOW',
  'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_PACKS', 'BUCKLE_ALLOW_SHELL', 'BUCKLE_ALLOW_CODE', 'BUCKLE_ALLOW_HISTORY', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_ALLOW_HOST_LSP',
  'BUCKLE_APPROVAL_TIMEOUT_MS', 'BUCKLE_MOUNTS', 'BUCKLE_SCRATCH_ROOTS', 'BUCKLE_SHELL_NETWORK', 'BUCKLE_SHELL_ISOLATION', 'BUCKLE_ALLOWED_HOSTS',
  'BUCKLE_BROWSER_CDP', 'BUCKLE_BROWSER_PROFILE', 'BUCKLE_BROWSER_ARGS', 'BUCKLE_BROWSER_HEADED',
  'BUCKLE_APPROVAL_JUDGE', 'BUCKLE_APPROVAL_JUDGE_PROVIDER', 'BUCKLE_APPROVAL_JUDGE_MODEL', 'BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS',
  'BUCKLE_APPROVAL_QUICK_JUDGE', 'BUCKLE_APPROVAL_QUICK_JUDGE_MODEL', 'BUCKLE_APPROVAL_FORMS', 'BUCKLE_APPROVAL_SESSION_IDLE_MS', 'BUCKLE_DELETE_IN_WORKSPACE', 'BUCKLE_MASS_DELETE_LIMIT',
  'BUCKLE_NETWORK_PRIVATE_RANGES',
])

/**
 * The decision AI's keys and the addresses its stages and Socket are asked at (D91, fix brief 1 item 17), which a node
 * reads from its environment file alone, as it reads every workspace's defaults: a shell's or an MCP config's env, which
 * an agent may be able to write, could otherwise send the owner's keys to a host it names and have its answer run calls.
 */
export const DECISION_AI_FILE_KEYS: readonly string[] = Object.freeze([
  'BUCKLE_JUDGE_API_KEY', 'BUCKLE_JUDGE_BASE_URL', 'BUCKLE_QUICK_JUDGE_API_KEY', 'BUCKLE_QUICK_JUDGE_BASE_URL', 'BUCKLE_SOCKET_API_KEY', 'BUCKLE_SOCKET_BASE_URL',
])

/** The decision AI's keys and addresses from `variables`: the environment file's, where the process entry reads its defaults from it alone. */
function decisionAiEndpoints(variables: NodeJS.ProcessEnv): Pick<NodeConfig, 'judgeApiKey' | 'judgeBaseUrl' | 'socketApiKey' | 'socketBaseUrl' | 'quickJudgeApiKey' | 'quickJudgeBaseUrl'> {
  return {
    judgeApiKey: variables.BUCKLE_JUDGE_API_KEY || undefined,
    judgeBaseUrl: parseNodeUrl('BUCKLE_JUDGE_BASE_URL', variables.BUCKLE_JUDGE_BASE_URL),
    socketApiKey: variables.BUCKLE_SOCKET_API_KEY || undefined,
    socketBaseUrl: parseNodeUrl('BUCKLE_SOCKET_BASE_URL', variables.BUCKLE_SOCKET_BASE_URL),
    quickJudgeApiKey: variables.BUCKLE_QUICK_JUDGE_API_KEY || undefined,
    quickJudgeBaseUrl: parseNodeUrl('BUCKLE_QUICK_JUDGE_BASE_URL', variables.BUCKLE_QUICK_JUDGE_BASE_URL),
  }
}

/**
 * The settings a node reads from its environment file alone (every workspace's defaults, and the decision AI's keys and
 * addresses) that the caller's environment sets to another value than the file holds, which the node does not read; all
 * it sets, where the node has no file. By name alone: a key's value is never part of the warning.
 */
export function unreadWorkspaceDefaults(layers: EnvironmentLayers): string[] {
  const file = layers.file
  if (file === null && layers.defaultsFromFileAlone !== true) return []
  return [...WORKSPACE_DEFAULT_KEYS, ...DECISION_AI_FILE_KEYS].filter(key => layers.caller[key] !== undefined && layers.caller[key] !== file?.values[key])
}

/**
 * The keys whose caller value, where it differs from the file's, refuses the move: the token and the folder it makes
 * the node's own. The node's other workspace settings are not among them, as the move copies none (D85, Q3) and the
 * node reads them from its file alone after it; its deny-type lists refuse the move apart (FLOOR_MIGRATION_KEYS).
 */
const MIGRATION_KEYS: readonly string[] = Object.freeze(['BUCKLE_AUTH_TOKEN', 'BUCKLE_WORKSPACE_ROOT'])

/**
 * The node's deny-type lists, which 0.1 took from the caller's environment over its file (fix brief 4, finding 8). A
 * caller naming other entries than the file would have the move drop what 0.1 enforced, so it refuses. buckle.env names
 * no tool list, so the denied tools have no key here.
 */
const FLOOR_MIGRATION_KEYS: readonly string[] = Object.freeze(['BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE'])

function migrationInput(merged: NodeJS.ProcessEnv, layers: EnvironmentLayers, platform: NodeJS.Platform): MigrationInput {
  const environment: NodeJS.ProcessEnv = layers.file?.values ?? merged
  const file = layers.file
  return {
    file: file?.path ?? null,
    authToken: environment.BUCKLE_AUTH_TOKEN ?? '',
    ...(environment.BUCKLE_WORKSPACE_ROOT ? { workspaceRoot: typedPath(environment.BUCKLE_WORKSPACE_ROOT, platform) } : {}),
    conflicts: file === null ? [] : MIGRATION_KEYS.filter(key => layers.caller[key] !== undefined && layers.caller[key] !== file.values[key]),
    // Compared as the entries each names, so the same list spelled otherwise (another separator or order, empty or unset)
    // is no conflict. A node with no file that reads its defaults from a file alone (the process entry's layers) reads
    // none after the move, so a list the caller names is compared with an empty one (finding 9 of the third re-check);
    // a caller building a config from one environment still reads its lists from it, and loses nothing.
    floorConflicts: file === null && layers.defaultsFromFileAlone !== true ? [] : FLOOR_MIGRATION_KEYS.filter(key => layers.caller[key] !== undefined && !sameEntries(parsePatterns(layers.caller[key]), parsePatterns(file?.values[key]))),
  }
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  const [one, other] = [new Set(left), new Set(right)]
  return one.size === other.size && [...one].every(entry => other.has(entry))
}

/**
 * The folder a node set up before the workspace model served, as the disk names it: BUCKLE_WORKSPACE_ROOT, or the
 * directory the command runs in. Refused where it is a whole drive, or where it holds the state directory, which an
 * agent writing anywhere in its workspace could then rewrite. Migration takes it as the node folder's workspace's folder (Q15).
 */
export function legacyWorkspaceRoot(input: { node: Pick<NodeConfig, 'migration' | 'stateDirectory'>; platform?: NodeJS.Platform }): string {
  const platform = input.platform ?? process.platform
  const setting = input.node.migration.workspaceRoot ? 'BUCKLE_WORKSPACE_ROOT' : 'The working directory, the workspace root while BUCKLE_WORKSPACE_ROOT is unset,'
  const typedRoot = input.node.migration.workspaceRoot ?? workingDirectory(platform)
  const root = realFolder(typedRoot, setting, platform)
  if (workspaceHolds(typedRoot, input.node.stateDirectory, platform)) {
    throw new Error(`BUCKLE_STATE_DIR is ${input.node.stateDirectory}, inside the BUCKLE_WORKSPACE_ROOT at ${root}: an agent writes anywhere in the workspace, and the state directory holds the recorded grants, the approvals and the empty hooks directory the forge tools run git with`)
  }
  return root
}

/** What one workspace's runtime is built from, beside the node's settings. */
export interface WorkspaceScope {
  history?: { keepTurns: number; turnIdleMs: number; maxFileBytes: number }
  id: string
  name: string
  /** True for the workspace migration made of the node's own folder (D85, Q15). */
  nodeFolder?: boolean
  /** The workspace's folder, as the disk names it. */
  dir: string
  /** Where the agent sees the folder, from its mount table; null shows the real path. */
  mount: string | null
  /** The owner's mounts in force: its own table's, else the node's. */
  mounts: readonly TableMount[]
  policy: WorkspacePolicy
  packs: { enabled: string[] | null; shell: boolean; code: boolean; history: boolean; hostGit: boolean; hostLsp: boolean }
  /** Milliseconds a gated call is held for an answer; 0 holds it until someone answers. */
  approvalWaitMs: number
  /** Whether its shell may reach the network, and runs on private copies (Phase 2 item 4). */
  shell: { network: boolean; isolation: boolean }
  /**
   * Its browser's mode, window, and idle timeout (Phase 2 item 6), and how a refusal names each setting: the workspace's
   * own by its key, the node's by its variable.
   */
  browser: { idleTimeoutMs: number; cdp?: string; profile?: string; args?: string; headed: boolean; names?: BrowserSettingNames }
  /** Its decision AI (D91). */
  approval: { sessionIdleMs: number; judge: JudgeMode; judgeProvider: JudgeProvider; judgeModel: string; judgeStandardScripts: readonly string[]; quickJudge: QuickJudgeScope; quickJudgeProvider: QuickJudgeProvider; quickJudgeModel: string }
  /** Its secret references (docs/user/how-to/secrets.md); on, and no file listed, where absent. */
  secrets?: { enabled: boolean; files: readonly string[] }
  /** Its delete policy (the delete policy brief). */
  files: { deleteInWorkspace: DeleteInWorkspace; massDeleteLimit: number }
  /** The CIDR ranges its network egress reaches on private addresses without asking. */
  network: { privateRanges: readonly string[] }
  /** Variables its shell commands see. */
  env: Readonly<Record<string, string>>
}

/**
 * The workspace settings a node's buckle.env names (D85, Q3 and Q14): the defaults every workspace takes where its own
 * workspace.json holds no value, as the workspace's, else these, else Buckle's built-in default (resolveSettings). An
 * empty value names none. Its allow-type lists (command allow, interpreters, approved URLs) stand where a workspace has
 * no list of its own; its deny-type lists (command deny, destructive) are a floor over every workspace's. They come
 * from the node's environment file alone where it has one (WORKSPACE_DEFAULT_KEYS; loadConfig). buckle.env
 * takes BUCKLE_ names alone, so it names no command variable, and `env` is empty: a workspace's own merge over it key by
 * key. A change applies when the node restarts, as every node setting's does (BUCKLE-D19).
 */
export interface NodeDefaults {
  /** The lists, empty where the environment names none; `mount` stays null, as `mount` below holds it. */
  policy: WorkspacePolicy
  mount?: string
  /**
   * The node's mounts, every workspace's where its own table holds none (Phase 2 item 1): BUCKLE_MOUNTS read-only at
   * the targets it names, and each BUCKLE_SCRATCH_ROOTS folder writable without asking at its own path.
   */
  mounts?: TableMount[]
  packs: { enabled?: string[]; shell?: boolean; code?: boolean; history?: boolean; hostGit?: boolean; hostLsp?: boolean }
  /** 0 holds a gated call until someone answers. */
  approvalWaitMs?: number
  /** BUCKLE_SHELL_NETWORK and BUCKLE_SHELL_ISOLATION, where buckle.env names them. */
  shell: { network?: boolean; isolation?: boolean }
  browser: { cdp?: string; profile?: string; args?: string; headed?: boolean }
  /**
   * BUCKLE_APPROVAL_JUDGE, its _PROVIDER, _MODEL, and _STANDARD_SCRIPTS, and BUCKLE_APPROVAL_QUICK_JUDGE and its _MODEL, where
   * buckle.env names them (D91), BUCKLE_APPROVAL_FORMS, whether MCP form answers decide, and BUCKLE_APPROVAL_SESSION_IDLE_MS,
   * the idle window after which sessions end.
   */
  approval: { forms?: boolean; sessionIdleMs?: number; judge?: JudgeMode; judgeProvider?: JudgeProvider; judgeModel?: string; judgeStandardScripts?: string[]; quickJudge?: QuickJudgeScope; quickJudgeModel?: string }
  /** BUCKLE_DELETE_IN_WORKSPACE and BUCKLE_MASS_DELETE_LIMIT, where buckle.env names them (the delete policy brief). */
  files: { deleteInWorkspace?: DeleteInWorkspace; massDeleteLimit?: number }
  /** BUCKLE_NETWORK_PRIVATE_RANGES, CIDR ranges separated by commas, where buckle.env names it. */
  network: { privateRanges?: string[] }
  env: Readonly<Record<string, string>>
}

/**
 * The node's workspace defaults from its environment, each checked as a workspace's own is, so a pattern Buckle refuses
 * stops the node, naming the variable, rather than covering nothing.
 */
export function nodeDefaultsFrom(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeDefaults {
  const policy = policyFromEnvironment(environment)
  for (const [key, patterns] of [['BUCKLE_COMMAND_ALLOW', policy.commands.allow], ['BUCKLE_COMMAND_DENY', policy.commands.deny], ['BUCKLE_COMMAND_DESTRUCTIVE', policy.commands.destructive ?? []]] as const) {
    refusedAs(key, () => compilePolicy({ ...emptyWorkspacePolicy(), commands: { allow: [...patterns], deny: [] } }))
  }
  refusedAs('BUCKLE_NETWORK_ALLOW', () => compilePolicy({ ...emptyWorkspacePolicy(), network: { allow: policy.network.allow } }))
  // One URL list per workspace (Phase 2 item 5): BUCKLE_ALLOWED_HOSTS is the node's list too, an exact host of it
  // clearing a private address as any exact entry does.
  policy.network.allow = [...new Set([...policy.network.allow, ...parseAllowedHosts(environment.BUCKLE_ALLOWED_HOSTS)])]
  refusedAs('BUCKLE_WORKSPACE_MOUNT', () => compilePolicy({ ...emptyWorkspacePolicy(), mount: policy.mount }))
  const browser = parseBrowserSettings(environment, platform)
  const flag = (key: string, on: string): boolean | undefined => (environment[key] ? environment[key] === on : undefined)
  const shell = environment.BUCKLE_ALLOW_SHELL ? environment.BUCKLE_ALLOW_SHELL !== 'false' : undefined
  const code = environment.BUCKLE_ALLOW_CODE ? environment.BUCKLE_ALLOW_CODE !== 'false' : undefined
  const history = environment.BUCKLE_ALLOW_HISTORY ? environment.BUCKLE_ALLOW_HISTORY !== 'false' : undefined
  const packs = parseList(environment.BUCKLE_PACKS)
  const approvalWait = environment.BUCKLE_APPROVAL_TIMEOUT_MS ? parseApprovalTimeout(environment.BUCKLE_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_WAIT_MS) ?? 0 : undefined
  const mounts = nodeMounts(environment, platform)
  return {
    policy: { ...policy, mount: null },
    ...(policy.mount === null ? {} : { mount: policy.mount }),
    ...(mounts.length === 0 ? {} : { mounts }),
    packs: {
      ...(packs.length > 0 ? { enabled: [...new Set(packs)] } : {}),
      ...(shell === undefined ? {} : { shell }),
      ...(code === undefined ? {} : { code }),
      ...(history === undefined ? {} : { history }),
      ...defined('hostGit', flag('BUCKLE_ALLOW_HOST_GIT', 'true')),
      ...defined('hostLsp', flag('BUCKLE_ALLOW_HOST_LSP', 'true')),
    },
    ...(approvalWait === undefined ? {} : { approvalWaitMs: approvalWait }),
    shell: { ...defined('network', flag('BUCKLE_SHELL_NETWORK', 'true')), ...(environment.BUCKLE_SHELL_ISOLATION ? { isolation: environment.BUCKLE_SHELL_ISOLATION !== 'false' } : {}) },
    browser: { ...browser.browserCdp ? { cdp: browser.browserCdp } : {}, ...browser.browserProfile ? { profile: browser.browserProfile } : {}, ...browser.browserArgs ? { args: browser.browserArgs } : {}, ...defined('headed', flag('BUCKLE_BROWSER_HEADED', 'true')) },
    approval: approvalDefaults(environment),
    files: deleteDefaults(environment),
    network: networkDefaults(environment),
    env: {},
  }
}

/** The node's private ranges, each checked as a workspace's own is, so a range Buckle refuses stops the node, naming the variable. */
function networkDefaults(environment: NodeJS.ProcessEnv): NodeDefaults['network'] {
  if (!environment.BUCKLE_NETWORK_PRIVATE_RANGES) return {}
  const ranges = parseList(environment.BUCKLE_NETWORK_PRIVATE_RANGES)
  for (const range of ranges) {
    const refusal = cidrRefusal(range)
    if (refusal) throw new Error(`Invalid BUCKLE_NETWORK_PRIVATE_RANGES entry ${range}: ${refusal}`)
  }
  return { privateRanges: [...new Set(ranges)] }
}

/** The node's delete policy defaults (the delete policy brief), each checked as a workspace's own is, so a value Buckle refuses stops the node, naming the variable. */
function deleteDefaults(environment: NodeJS.ProcessEnv): NodeDefaults['files'] {
  const mode = environment.BUCKLE_DELETE_IN_WORKSPACE || undefined
  const limit = environment.BUCKLE_MASS_DELETE_LIMIT || undefined
  const deleteInWorkspace = mode === undefined ? undefined : parseDeleteInWorkspace(mode)
  if (deleteInWorkspace === null) throw new Error('Invalid BUCKLE_DELETE_IN_WORKSPACE: allow or ask')
  const massDeleteLimit = limit === undefined ? undefined : parseMassDeleteLimit(limit)
  if (massDeleteLimit === null) throw new Error(`Invalid BUCKLE_MASS_DELETE_LIMIT: entries, 0 to ${MAX_MASS_DELETE_LIMIT}, 0 for no limit`)
  return { ...defined('deleteInWorkspace', deleteInWorkspace), ...defined('massDeleteLimit', massDeleteLimit) }
}

/**
 * The node's decision AI defaults (D91), each checked as a workspace's own is, so a value Buckle refuses stops the node,
 * naming the variable. The standard scripts are command globs separated by ;;, and an empty value names none. MCP form
 * answers decide only at BUCKLE_APPROVAL_FORMS=true, as the node's other switches read.
 */
function approvalDefaults(environment: NodeJS.ProcessEnv): NodeDefaults['approval'] {
  const judge = environment.BUCKLE_APPROVAL_JUDGE || undefined
  const judgeProvider = environment.BUCKLE_APPROVAL_JUDGE_PROVIDER || undefined
  const judgeModel = environment.BUCKLE_APPROVAL_JUDGE_MODEL || undefined
  if (judge !== undefined && !(JUDGE_MODES as readonly string[]).includes(judge)) throw new Error(`Invalid BUCKLE_APPROVAL_JUDGE: ${JUDGE_MODES.join(', ')}`)
  if (judgeProvider !== undefined && !(JUDGE_PROVIDERS as readonly string[]).includes(judgeProvider)) throw new Error(`Invalid BUCKLE_APPROVAL_JUDGE_PROVIDER: ${JUDGE_PROVIDERS.join(' or ')}`)
  if (judgeModel !== undefined && !JUDGE_MODEL_NAME.test(judgeModel)) throw new Error('Invalid BUCKLE_APPROVAL_JUDGE_MODEL: a model name, with no blank')
  const quickJudge = environment.BUCKLE_APPROVAL_QUICK_JUDGE || undefined
  const quickJudgeModel = environment.BUCKLE_APPROVAL_QUICK_JUDGE_MODEL || undefined
  if (quickJudge !== undefined && !(QUICK_JUDGE_SCOPES as readonly string[]).includes(quickJudge)) throw new Error(`Invalid BUCKLE_APPROVAL_QUICK_JUDGE: ${QUICK_JUDGE_SCOPES.join(', ')}`)
  if (quickJudgeModel !== undefined && !JUDGE_MODEL_NAME.test(quickJudgeModel)) throw new Error('Invalid BUCKLE_APPROVAL_QUICK_JUDGE_MODEL: a model name, with no blank')
  const scripts = environment.BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS === undefined ? undefined : parsePatterns(environment.BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS)
  for (const glob of scripts ?? []) {
    try { compileCommandGlob(glob) } catch (error) {
      if (error instanceof CommandGlobError) throw new Error(`Invalid BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS: ${error.message}`)
      throw error
    }
  }
  const forms = environment.BUCKLE_APPROVAL_FORMS ? environment.BUCKLE_APPROVAL_FORMS === 'true' : undefined
  const idle = environment.BUCKLE_APPROVAL_SESSION_IDLE_MS || undefined
  const sessionIdleMs = idle === undefined ? undefined : parseSessionIdle(idle)
  if (sessionIdleMs === null) throw new Error(`Invalid BUCKLE_APPROVAL_SESSION_IDLE_MS: milliseconds, ${SESSION_IDLE_BOUNDS.min} to ${SESSION_IDLE_BOUNDS.max}, or 0 to end no session at idle`)
  return {
    ...defined('forms', forms), ...defined('sessionIdleMs', sessionIdleMs),
    ...defined('judge', judge as JudgeMode | undefined), ...defined('judgeProvider', judgeProvider as JudgeProvider | undefined),
    ...defined('judgeModel', judgeModel), ...defined('judgeStandardScripts', scripts),
    ...defined('quickJudge', quickJudge as QuickJudgeScope | undefined), ...defined('quickJudgeModel', quickJudgeModel),
  }
}

/** A base URL the node asks a service at (BUCKLE_JUDGE_BASE_URL and its kin): http or https, the operator's, never one a tool supplies. */
function parseNodeUrl(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`Invalid ${name}: an http or https URL`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Invalid ${name}: an http or https URL`)
  return value
}

/**
 * The node's mounts (Phase 2 item 1): BUCKLE_MOUNTS read-only at the targets it names, then each BUCKLE_SCRATCH_ROOTS
 * folder at its own path, each source as the disk names it, links followed, as the workspace root is: a judged effect
 * path is real and in the disk's case, and a source swapped for a link after the node started is refused at its use
 * (mountSourceState), as one of the owner's is.
 */
function nodeMounts(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): TableMount[] {
  const shared = parseSandboxMounts(environment.BUCKLE_MOUNTS).map((mount): TableMount => ({ source: realPathOf(mount.source, platform), target: mount.target, access: 'ro', node: true }))
  const scratch = parseList(environment.BUCKLE_SCRATCH_ROOTS).map((root): TableMount => {
    const path = realFolder(typedPath(root, platform), 'BUCKLE_SCRATCH_ROOTS', platform)
    return { source: path, target: path, access: 'rw', scratch: true }
  })
  return [...shared, ...scratch]
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>
}

/** A compile that refuses, said as the variable the value came from. */
function refusedAs(key: string, compile: () => unknown): void {
  try { compile() } catch (error) {
    if (error instanceof PolicyError) throw new Error(`Invalid ${key}: ${error.message}`)
    throw error
  }
}

/**
 * One workspace's runtime configuration (D83): the node's settings, then the workspace's own. Every workspace keeps its
 * state in `workspaces/<id>/` under the node's directory, the one made from the node's own folder included (D85, Q15).
 * Each takes the node's BUCKLE_SKILLS_DIRS and BUCKLE_STRICT_WRITES (fix brief 1, F; finding 43 of the Phase 1 review);
 * its mounts are its table's, else the node's (Phase 2 item 1).
 */
export function workspaceConfig(node: NodeConfig, scope: WorkspaceScope): BuckleConfig {
  return {
    ...node,
    workspaceId: scope.id,
    cwd: scope.dir,
    serverName: scope.name,
    nodeFolder: scope.nodeFolder === true,
    stateDirectory: join(node.stateDirectory, 'workspaces', scope.id),
    nodeStateDirectory: node.stateDirectory,
    ...workspaceFields(scope),
  }
}

/** The fields of a workspace's configuration its workspace.json decides, which a running workspace takes up between calls (Q2). */
export type WorkspaceFields = Pick<BuckleConfig, 'policy' | 'mounts' | 'shellNetwork' | 'isolateShell' | 'approvalJudge' | 'approvalJudgeProvider' | 'approvalJudgeModel' | 'approvalJudgeStandardScripts' | 'approvalQuickJudge' | 'approvalQuickJudgeProvider' | 'approvalQuickJudgeModel' | 'browserCdp' | 'browserProfile' | 'browserArgs' | 'browserHeaded' | 'browserIdleTimeoutMs' | 'browserSettingNames' | 'enabledPacks' | 'enableShell' | 'allowCode' | 'allowHistory' | 'allowHostGit' | 'allowHostLsp' | 'approvalTimeoutMs' | 'approvalSessionIdleMs' | 'secretsEnabled' | 'secretFiles' | 'deleteInWorkspace' | 'massDeleteLimit' | 'networkPrivateRanges' | 'commandEnvironment' | 'history'>

export function workspaceFields(scope: Pick<WorkspaceScope, 'mount' | 'mounts' | 'policy' | 'packs' | 'approvalWaitMs' | 'shell' | 'browser' | 'approval' | 'secrets' | 'files' | 'network' | 'env' | 'history'>): WorkspaceFields {
  return {
    history: scope.history ?? { keepTurns: 10, turnIdleMs: 60_000, maxFileBytes: 33_554_432 },
    policy: { ...scope.policy, mount: scope.mount },
    mounts: scope.mounts.map(mount => ({ ...mount })),
    shellNetwork: scope.shell.network,
    isolateShell: scope.shell.isolation,
    approvalJudge: scope.approval.judge,
    approvalJudgeProvider: scope.approval.judgeProvider,
    approvalJudgeModel: scope.approval.judgeModel,
    approvalJudgeStandardScripts: [...scope.approval.judgeStandardScripts],
    approvalQuickJudge: scope.approval.quickJudge,
    approvalQuickJudgeProvider: scope.approval.quickJudgeProvider,
    approvalQuickJudgeModel: scope.approval.quickJudgeModel,
    // Each set, or unset, so a value the workspace takes away is gone from the next call's settings too.
    browserCdp: scope.browser.cdp,
    browserProfile: scope.browser.profile,
    browserArgs: scope.browser.args,
    browserHeaded: scope.browser.headed,
    browserIdleTimeoutMs: scope.browser.idleTimeoutMs,
    browserSettingNames: scope.browser.names,
    enabledPacks: scope.packs.enabled === null ? undefined : [...scope.packs.enabled],
    enableShell: scope.packs.shell,
    allowCode: scope.packs.code,
    allowHistory: scope.packs.history,
    allowHostGit: scope.packs.hostGit,
    allowHostLsp: scope.packs.hostLsp,
    approvalTimeoutMs: scope.approvalWaitMs === 0 ? null : scope.approvalWaitMs,
    approvalSessionIdleMs: scope.approval.sessionIdleMs,
    secretsEnabled: scope.secrets?.enabled ?? true,
    secretFiles: [...scope.secrets?.files ?? []],
    deleteInWorkspace: scope.files.deleteInWorkspace,
    massDeleteLimit: scope.files.massDeleteLimit,
    networkPrivateRanges: [...scope.network.privateRanges],
    commandEnvironment: { ...scope.env },
  }
}

/** The scratch roots of a mount table: writable without asking, at their own path. */
export function scratchSources(mounts: readonly TableMount[]): string[] {
  return mounts.filter(mount => mount.scratch).map(mount => mount.source)
}

/** A mount table's mounts as the shell binds them, at their targets, each read-only unless the owner shares it writable (Q6). */
export function sandboxBinds(mounts: readonly TableMount[]): SandboxBind[] {
  return mounts.filter(mount => !mount.scratch).map(mount => ({ source: mount.source, target: mount.target, readOnly: mount.access === 'ro', ...(mount.node ? { node: true as const } : {}) }))
}

/** A workspace's own state directory, the node's when they differ, and the node's environment files. */
type StateDirectories = Pick<BuckleConfig, 'stateDirectory'> & Partial<Pick<BuckleConfig, 'nodeStateDirectory' | 'environmentFile' | 'recordedEnvironmentFiles'>>

/**
 * Node configuration and all workspace maps are owner-only, never tool-accessible, and so are the node's environment
 * file wherever it lies and the unit or agent that starts the node at login. Effects are judged at their real paths, so
 * each root is named by its real path too (a symlinked home, macOS /var), in the case the disk stores it
 * (realpathSync.native); the rule folds case where the disk ignores it.
 */
export function protectedStateRoots(config: StateDirectories, platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): string[] {
  // What starts this node at login, so no agent rewrites what runs then: on Linux the unit, its link, and the drop-ins and
  // copy systemd reads beside it (Phase 3, item 6, and fix brief 6, item 4); on macOS the launchd agent's property list.
  const definition = platform === 'linux' ? systemdGuardedPaths(environment, homeDirectory(platform)) : platform === 'darwin' ? launchdGuardedPaths(homeDirectory(platform)) : []
  const named = [join(homeDirectory(), '.5straps'), config.nodeStateDirectory ?? config.stateDirectory, ...settingsFiles(config), ...definition]
  return [...new Set([...named, ...named.map(path => realPathOf(path))])]
}

/** The node's environment files among the protected roots, as typed and where each really is: files, there or not, never masked as folders. */
export function protectedSettingsFiles(config: StateDirectories): string[] {
  const files = settingsFiles(config)
  return [...new Set([...files, ...files.map(path => realPathOf(path))])]
}

function settingsFiles(config: StateDirectories): string[] {
  return [...(config.environmentFile === undefined ? [] : [config.environmentFile]), ...config.recordedEnvironmentFiles ?? []]
}

/**
 * Whether a workspace root holds a path, as typed and where each really is, compared as the disk compares: a root or
 * a state directory spelled through a link, or in another case where the disk ignores case, must not start a node
 * whose state an agent can write. `buckle init` refuses by the same test.
 */
export function workspaceHolds(typedRoot: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const root = realPathOf(typedRoot, platform)
  return isInside(typedRoot, path, platform) || isInside(root, path, platform) || isInsideComparable(root, realPathOf(path, platform), ignoresCase(platform), platform)
}

/** Whether two paths name one directory where each really is, compared as the platform's disks compare names. */
export function sameDirectory(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const [one, other] = [realPathOf(left, platform), realPathOf(right, platform)]
  return isInsideComparable(one, other, ignoresCase(platform), platform) && isInsideComparable(other, one, ignoresCase(platform), platform)
}

/**
 * A typed root as the disk names it (realPathOf), refused on Windows where it is a whole drive (`D:\`), as typed or
 * where it really is: everything on the drive would be the workspace or the scratch the agent writes without asking.
 * `setting` names where the root came from.
 */
function realFolder(typed: string, setting: string, platform: NodeJS.Platform): string {
  return folder(realPathOf(folder(typed, setting, platform), platform), setting, platform)
}

/** A root refused on Windows where it is a whole drive (isDriveRoot), named by the setting it came from. */
function folder(path: string, setting: string, platform: NodeJS.Platform): string {
  if (isDriveRoot(path, platform)) throw new Error(`${setting} is ${path}: ${WHOLE_DRIVE}`)
  return path
}

/** The node's environment file in its state directory, which `buckle init` and pairing write. */
export const ENVIRONMENT_FILE_NAME = 'buckle.env'

/**
 * Where the node's settings live: buckle.env in the state directory (BUCKLE_STATE_DIR from the process environment,
 * ~/.5straps/buckle by default), or the file BUCKLE_ENV_FILE names. The working directory is never consulted: settings
 * and credentials stay under the owner's state, away from any project an agent works in.
 */
export function environmentFilePath(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const named = environment.BUCKLE_ENV_FILE
  if (!named) return defaultEnvironmentFile(environment, platform)
  // Relative, it would name another file in every directory a command starts in.
  if (!isAbsolute(named)) throw new Error(`BUCKLE_ENV_FILE must be an absolute path, not ${named}: Buckle never resolves its settings against the working directory`)
  return typedPath(named, platform)
}

/** buckle.env in the state directory the process environment names. */
export function defaultEnvironmentFile(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(stateDirectoryOf(environment, platform), ENVIRONMENT_FILE_NAME)
}

/** Where grants, approvals and the action log live, read without loading the rest of the config. */
export function stateDirectoryOf(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const named = environment.BUCKLE_STATE_DIR
  if (!named) return join(homeDirectory(platform), '.5straps', 'buckle')
  // Relative, it would name another directory in every directory a command starts in (review L13 of B20-B22).
  if (!isAbsolute(named)) throw new Error(`BUCKLE_STATE_DIR must be an absolute path, not ${named}: Buckle never resolves its state against the working directory`)
  // Refused as typed and where it really is, as the workspace root is; named as typed, and protectedStateRoots adds the real path.
  const typed = typedPath(named, platform)
  realFolder(typed, 'BUCKLE_STATE_DIR', platform)
  return typed
}

export function grantsPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'grants.json')
}

export function pluginsPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'plugins.json')
}

export function approvalsPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'approvals.json')
}

export function approvalNoncesPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'approval-nonces.json')
}

export function actionsPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'actions.jsonl')
}

export function policyPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'policy.json')
}

/** The client keys the owner enrolled on this node (owner ruling H4 of 2026-09-28): one list per node, beside its registry. */
export function clientKeysPath(config: StateDirectories): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'client-keys.json')
}

/** The nonces of signed requests this node verified, so none lands twice inside its window. */
export function requestNoncesPath(config: StateDirectories): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'request-nonces.json')
}

/** The node's own signing key, which signs what it shows a person's client (B24). */
export function nodeKeyPath(config: StateDirectories): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'node-signing-key.pem')
}

/** The setup sessions persons' keys opened on this node (B24). */
export function setupSessionsPath(config: StateDirectories): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'setup-sessions.json')
}

/** The dangerously-allow switch, beside the policy and never inside it (review H1 of B20-B22). */
export function dangerouslyAllowPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'dangerously-allow.json')
}

/** The value is never echoed: a malformed key names the variable and the fix alone. */
function parseRingsApprovalKey(value: string | undefined): ApprovalKey | undefined {
  if (!value?.trim()) return undefined
  try {
    return approvalKey(value.trim())
  } catch {
    throw new Error('BUCKLE_RINGS_APPROVAL_KEY is not an approval key (32 bytes in base64url); remove it, or set the key this node shares with its control plane')
  }
}

/**
 * The node's policy lists from its environment, its workspace defaults (nodeDefaultsFrom; D85, Q3 and Q14). Patterns
 * are shell-word globs, one per line or separated by `;;`. BUCKLE_ALLOWED_INTERPRETERS names, comma separated, the
 * interpreters read as ordinary commands.
 */
export function policyFromEnvironment(environment: NodeJS.ProcessEnv): WorkspacePolicy {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = parsePatterns(environment.BUCKLE_COMMAND_ALLOW)
  policy.commands.deny = parsePatterns(environment.BUCKLE_COMMAND_DENY)
  policy.commands.destructive = parsePatterns(environment.BUCKLE_COMMAND_DESTRUCTIVE)
  const interpreters = [...new Set(parseList(environment.BUCKLE_ALLOWED_INTERPRETERS))]
  const unknown = interpreters.find(name => !isInterpreter(name))
  if (unknown !== undefined) throw new Error(`Invalid BUCKLE_ALLOWED_INTERPRETERS: ${unknown} is not an interpreter Buckle reads as unknown: ${INTERPRETER_NAMES}`)
  if (interpreters.length > 0) policy.commands.allowedInterpreters = interpreters
  policy.network.allow = parseList(environment.BUCKLE_NETWORK_ALLOW)
  policy.mount = environment.BUCKLE_WORKSPACE_MOUNT?.trim() || null
  return policy
}

function parsePatterns(value: string | undefined): string[] {
  if (!value) return []
  return value.split(/\r?\n|;;/).map(item => item.trim()).filter(Boolean)
}

function parseSandboxMode(value: string | undefined): NodeConfig['sandboxMode'] {
  if (!value || value === 'auto') return 'auto'
  const parsed = SandboxModeSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Invalid BUCKLE_SANDBOX: ${value}`)
  return parsed.data
}

/**
 * BUCKLE_APPROVAL_TIMEOUT_MS: how long Buckle holds a gated call for an answer when the caller sends no
 * wait of its own, in milliseconds; 0 holds it until someone answers, with no deadline. A caller's hint
 * overrides it either way (InvokeContext.approvalWait, owner ruling of 2026-09-28). Returns null for no
 * deadline. One spelling (ruling 2): `forever` is refused with the one to use.
 */
export function parseApprovalTimeout(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === '') return fallback
  if (value === 'forever') throw new Error('Invalid BUCKLE_APPROVAL_TIMEOUT_MS: forever; use 0 to wait until someone answers or the session ends')
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) throw new Error(`Invalid BUCKLE_APPROVAL_TIMEOUT_MS: ${value}`)
  return parsed === 0 ? null : parsed
}

function parseForgeApiUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_FORGE_API_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid BUCKLE_FORGE_GITHUB_API_URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid BUCKLE_FORGE_GITHUB_API_URL: ${raw} is not an http or https URL`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function parseGitAuthor(value: string | undefined): { name: string; email: string } {
  const raw = value?.trim() || DEFAULT_FORGE_GIT_AUTHOR
  const match = GIT_AUTHOR_PATTERN.exec(raw)
  if (!match) throw new Error(`Invalid BUCKLE_FORGE_GIT_AUTHOR: ${raw}; expected "Name <email>"`)
  return { name: match[1]!.trim(), email: match[2]! }
}

/**
 * The owner's browser choices. An attached browser is the one its owner started, with its own profile, arguments,
 * and window, so BUCKLE_BROWSER_CDP is refused beside the settings that would choose them. A refusal names the
 * settings, never a value: a DevTools URL can carry a token, and a profile path is the owner's.
 */
export function parseBrowserSettings(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): { browserCdp?: string; browserProfile?: string; browserArgs?: string } {
  const browserCdp = parseBrowserCdp(environment.BUCKLE_BROWSER_CDP)
  const browserProfile = parseBrowserProfile(environment.BUCKLE_BROWSER_PROFILE, platform)
  const browserArgs = parseBrowserArgs(environment.BUCKLE_BROWSER_ARGS, platform)
  const beside = [browserProfile && 'BUCKLE_BROWSER_PROFILE', browserArgs && 'BUCKLE_BROWSER_ARGS', environment.BUCKLE_BROWSER_HEADED === 'true' && 'BUCKLE_BROWSER_HEADED']
    .filter((name): name is string => Boolean(name))
  if (browserCdp && beside.length > 0) {
    throw new Error(`BUCKLE_BROWSER_CDP cannot be set with ${beside.join(' or ')}: an attached browser keeps the profile, arguments, and window its owner started it with`)
  }
  return {
    ...(browserCdp ? { browserCdp } : {}),
    ...(browserProfile ? { browserProfile } : {}),
    ...(browserArgs ? { browserArgs } : {}),
  }
}

/** The browser settings a refusal names: each by its environment variable unless a caller names it otherwise. */
export interface BrowserSettingNames { cdp: string; profile: string; args: string; headed: string }

const BROWSER_VARIABLES: BrowserSettingNames = { cdp: 'BUCKLE_BROWSER_CDP', profile: 'BUCKLE_BROWSER_PROFILE', args: 'BUCKLE_BROWSER_ARGS', headed: 'BUCKLE_BROWSER_HEADED' }

/**
 * Why a browser block is refused, or null: the checks the node's own settings meet at start (parseBrowserSettings): an
 * attached browser beside a profile, arguments, or a window; a profile that is no absolute path; a DevTools value of
 * another shape; and arguments Buckle refuses. Each setting is named as `names` says, as the variable by default,
 * never by its value.
 */
export function browserBlockRefusal(block: { cdp?: string | undefined; profile?: string | undefined; args?: string | undefined; headed?: boolean | undefined }, platform: NodeJS.Platform = process.platform, names: Partial<BrowserSettingNames> = {}): string | null {
  try {
    parseBrowserSettings({ BUCKLE_BROWSER_CDP: block.cdp, BUCKLE_BROWSER_PROFILE: block.profile, BUCKLE_BROWSER_ARGS: block.args, ...(block.headed ? { BUCKLE_BROWSER_HEADED: 'true' } : {}) }, platform)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return (Object.keys(BROWSER_VARIABLES) as Array<keyof BrowserSettingNames>).reduce((text, key) => text.replaceAll(BROWSER_VARIABLES[key], names[key] ?? BROWSER_VARIABLES[key]), message)
  }
}

/**
 * A DevTools port, or a ws://, wss://, http://, or https:// URL, as agent-browser's `--cdp` takes them. agent-browser
 * reads the scheme in lower case only and quotes the whole value when it cannot, so the scheme is lowered here.
 */
export function parseBrowserCdp(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN
  if (port >= 1 && port <= 65_535) return raw
  const scheme = /^(?:wss?|https?):\/\//i.exec(raw)?.[0]
  if (scheme && URL.canParse(raw)) return `${scheme.toLowerCase()}${raw.slice(scheme.length)}`
  throw new Error('Invalid BUCKLE_BROWSER_CDP: expected a DevTools port such as 9222, or a ws://, wss://, http://, or https:// URL')
}

/** Absolute, so it names one folder whatever directory a command starts in. Where it lies is judged when the pack is built. */
export function parseBrowserProfile(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  // On Windows a path rooted at a slash alone names whichever drive is current, so it is no absolute path either.
  if (!isAbsolute(raw) || (platform === 'win32' && /^[/\\](?![/\\])/.test(raw))) throw new Error('BUCKLE_BROWSER_PROFILE must be an absolute path: Buckle never resolves a browser profile against the working directory')
  try {
    return typedPath(raw, platform)
  } catch {
    throw new Error('BUCKLE_BROWSER_PROFILE is a path Buckle cannot read as the system does')
  }
}

/** Passed whole as agent-browser's `--args`, once nothing in it is refused (browserArgumentsRefusal). */
export function parseBrowserArgs(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const refusal = browserArgumentsRefusal(raw, platform)
  if (refusal) throw new Error(refusal)
  return raw
}

/** Each entry is checked at load, so a malformed pattern stops the node rather than covering nothing. */
function parseAllowedHosts(value: string | undefined): string[] {
  const entries = parseList(value)
  for (const entry of entries) {
    try {
      compileHostPattern(entry)
    } catch (error) {
      if (error instanceof UrlPatternError) throw new Error(`Invalid BUCKLE_ALLOWED_HOSTS entry: ${error.message}`)
      throw error
    }
  }
  return entries
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`)
  return parsed
}
