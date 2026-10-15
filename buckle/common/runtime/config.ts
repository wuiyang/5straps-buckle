import { parseSandboxMounts, type SandboxMount } from '../domain/sandbox-mounts.js'
import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join } from 'pathe'
import { emptyWorkspacePolicy, SandboxModeSchema, type WorkspacePolicy } from '@5straps/protocol'
import { approvalKey, type ApprovalKey } from '@5straps/protocol/envelope'
import { browserArgumentsRefusal } from '../domain/browser-arguments.js'
import { INTERPRETER_NAMES, isInterpreter } from '../domain/command-forms.js'
import { childPath, homeDirectory, ignoresCase, isDriveRoot, isInside, isInsideComparable, nativePath, parentDirectory, typedPath, WHOLE_DRIVE, workingDirectory } from '../domain/paths.js'
import { compileHostPattern, UrlPatternError } from '../domain/url-pattern.js'

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TIMEOUT_MS = 300_000
/** How long a gated call is held for an answer when the workspace names no wait of its own. */
export const DEFAULT_APPROVAL_WAIT_MS = 15_000
const DEFAULT_FORGE_API_URL = 'https://api.github.com'
const DEFAULT_FORGE_GIT_AUTHOR = '5straps agent <agent@5straps.local>'
const GIT_AUTHOR_PATTERN = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/

/** The workspace the node's own folder became at migration (owner decision Q15): its id, and its state stays in the node's directory. */
export const NODE_FOLDER_WORKSPACE = 'default'

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
   * hashes the file's into workspace default's tokens as `node` (MigrationInput) and takes it out of the file; a node
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
  /** Directories writable without asking. Empty by default, so the first write anywhere asks. */
  scratchRoots: string[]
  strictWrites: boolean
  sandboxMode: 'auto' | 'none' | 'bubblewrap' | 'seatbelt'
  acknowledgedUnsandboxed: boolean
  historyMaxBytes: number
  historyRetentionDays: number
  shellNetwork: boolean
  isolateShell: boolean
  isolationMaxBytes: number
  environmentValidator?: string
  allowedHosts: string[]
  braveSearchApiKey?: string
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
  /** Show the browser window. Headless by default, because a Buckle node usually has no display. */
  browserHeaded: boolean
  /** BUCKLE_BROWSER_CDP: the DevTools port or URL of the owner's own Chrome, which every browser command attaches to. */
  browserCdp?: string
  /** BUCKLE_BROWSER_PROFILE: a profile folder the browser keeps cookies and storage in across launches, as the disk names it. */
  browserProfile?: string
  /** BUCKLE_BROWSER_ARGS: Chromium arguments for a browser Buckle launches, as agent-browser's `--args` reads them. */
  browserArgs?: string
  /** Where to announce a pending approval, so a person can be reached away from the machine. */
  approvalWebhook?: string
  /** Owner-authorized read-only file and folder aliases, scoped to the node's own folder (workspace default). */
  sandboxMounts?: SandboxMount[]
  /** Host directories still readable inside a mounted sandbox, for toolchains outside /usr. */
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
  /** How long a state file update waits for another process's lock; the store's default when absent. Never read from the environment. */
  stateLockDeadlineMs?: number
  maxRequestBytes: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

/**
 * One workspace's runtime configuration: the node's settings with the workspace's own over them, from its registry
 * record and its workspace.json (workspaceConfig). `serverName` is the workspace's name.
 */
export interface BuckleConfig extends NodeConfig {
  cwd: string
  enabledPacks?: string[]
  allowHostGit: boolean
  allowHostLsp: boolean
  enableShell: boolean
  /** Code mode's code_run and code_api (owner decision D82). */
  allowCode: boolean
  /** How long a gated call is held for an answer, in milliseconds; null holds it until someone answers. */
  approvalTimeoutMs: number | null
  /** The plain variables the workspace's settings give its shell commands (Q13); a call's own `env` is set over them. */
  commandEnvironment: Readonly<Record<string, string>>
  /** The workspace's policy, from its workspace.json, with its mount's target as `mount`. */
  policy: WorkspacePolicy
  /** The node's own state directory, which holds the registry and every workspace's settings. */
  nodeStateDirectory?: string
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
}

/**
 * What migration reads, once (Q14, Q15): the environment file's own values, never what a shell or an MCP config's env
 * set over them, so the first command after an upgrade cannot write its caller's settings into every workspace for
 * good (finding 34 of the Phase 1 review). A node with no file was configured by the environment it starts with, and
 * that is what migration reads there.
 */
export interface MigrationInput {
  /** The environment file read, which migration takes BUCKLE_AUTH_TOKEN out of once it is hashed; null where none was. */
  file: string | null
  /** The workspace settings it names (WORKSPACE_ENVIRONMENT_KEYS and the browser's). */
  settings: Readonly<Record<string, string>>
  /** BUCKLE_AUTH_TOKEN, which becomes workspace default's token `node`. */
  authToken: string
  /** BUCKLE_WORKSPACE_ROOT as typed: workspace default's folder. */
  workspaceRoot?: string
  /** The keys the caller's own environment sets to another value than the file holds, which refuse the move. */
  conflicts: readonly string[]
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
    // As the disk names each, as the workspace root is: a judged effect path is real and in the disk's case.
    scratchRoots: parseList(environment.BUCKLE_SCRATCH_ROOTS).map(root => realFolder(typedPath(root, platform), 'BUCKLE_SCRATCH_ROOTS', platform)),
    strictWrites: environment.BUCKLE_STRICT_WRITES === 'true',
    sandboxMode,
    acknowledgedUnsandboxed: sandboxMode === 'none',
    historyMaxBytes: parsePositiveInteger(environment.BUCKLE_HISTORY_MAX_BYTES, 1_073_741_824),
    historyRetentionDays: parsePositiveInteger(environment.BUCKLE_HISTORY_RETENTION_DAYS, 30),
    experimentalAdminHttp: environment.BUCKLE_EXPERIMENTAL_ADMIN_HTTP === 'true',
    shellNetwork: environment.BUCKLE_SHELL_NETWORK === 'true',
    isolateShell: environment.BUCKLE_SHELL_ISOLATION !== 'false',
    isolationMaxBytes: parsePositiveInteger(environment.BUCKLE_ISOLATION_MAX_BYTES, 268_435_456),
    environmentValidator: environment.BUCKLE_ENV_VALIDATOR_COMMAND || undefined,
    allowedHosts: parseAllowedHosts(environment.BUCKLE_ALLOWED_HOSTS),
    braveSearchApiKey: environment.BUCKLE_BRAVE_SEARCH_API_KEY || undefined,
    forgeGithubToken: environment.BUCKLE_FORGE_GITHUB_TOKEN || undefined,
    forgeApiUrl: parseForgeApiUrl(environment.BUCKLE_FORGE_GITHUB_API_URL),
    forgeGitAuthor: parseGitAuthor(environment.BUCKLE_FORGE_GIT_AUTHOR),
    // Empty reads as unset, as the validator's setting does, so `buckle init` and the node look up the same program.
    agentBrowserCommand: environment.BUCKLE_AGENT_BROWSER_COMMAND || 'agent-browser',
    browserHeaded: environment.BUCKLE_BROWSER_HEADED === 'true',
    ...parseBrowserSettings(environment, platform),
    approvalWebhook: environment.BUCKLE_APPROVAL_WEBHOOK || undefined,
    sandboxMounts: parseSandboxMounts(environment.BUCKLE_MOUNTS),
    mountReadOnlyPaths: parseList(environment.BUCKLE_MOUNT_READ_ONLY).map(path => typedPath(path, platform)),
    reportUrl: environment.BUCKLE_REPORT_URL || undefined,
    reportToken: environment.BUCKLE_REPORT_TOKEN || undefined,
    ringsApprovalKey: parseRingsApprovalKey(environment.BUCKLE_RINGS_APPROVAL_KEY),
    skillDirectories: parseList(environment.BUCKLE_SKILLS_DIRS),
    stateDirectory,
    maxRequestBytes: parsePositiveInteger(environment.BUCKLE_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES),
    defaultTimeoutMs: parsePositiveInteger(environment.BUCKLE_DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: parsePositiveInteger(environment.BUCKLE_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS),
  }
}

/**
 * The workspace settings a node set up before the workspace model kept in its environment (Q14 of the workspace-model
 * brief): migration input only, and ignored by a node once its workspaces carry their own (environmentWorkspaceKeys).
 */
export const WORKSPACE_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([
  'BUCKLE_COMMAND_ALLOW', 'BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE', 'BUCKLE_ALLOWED_INTERPRETERS', 'BUCKLE_NETWORK_ALLOW',
  'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_PACKS', 'BUCKLE_ALLOW_SHELL', 'BUCKLE_ALLOW_CODE', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_ALLOW_HOST_LSP',
  'BUCKLE_APPROVAL_TIMEOUT_MS',
])

const BROWSER_KEYS = ['BUCKLE_BROWSER_CDP', 'BUCKLE_BROWSER_PROFILE', 'BUCKLE_BROWSER_ARGS', 'BUCKLE_BROWSER_HEADED']

/**
 * The keys whose caller value, where it differs from the file's, refuses the move. The browser's are left out: they
 * still drive the browser from the node's environment, where a caller's value is an ordinary override, and migration
 * copies the file's into each workspace.json, which nothing reads yet.
 */
const MIGRATION_KEYS: readonly string[] = Object.freeze([...WORKSPACE_ENVIRONMENT_KEYS, 'BUCKLE_AUTH_TOKEN', 'BUCKLE_WORKSPACE_ROOT'])

function migrationInput(merged: NodeJS.ProcessEnv, layers: EnvironmentLayers, platform: NodeJS.Platform): MigrationInput {
  const environment: NodeJS.ProcessEnv = layers.file?.values ?? merged
  const file = layers.file
  return {
    file: file?.path ?? null,
    settings: Object.freeze(Object.fromEntries([...WORKSPACE_ENVIRONMENT_KEYS, ...BROWSER_KEYS].flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]]]))),
    authToken: environment.BUCKLE_AUTH_TOKEN ?? '',
    ...(environment.BUCKLE_WORKSPACE_ROOT ? { workspaceRoot: typedPath(environment.BUCKLE_WORKSPACE_ROOT, platform) } : {}),
    conflicts: file === null ? [] : MIGRATION_KEYS.filter(key => layers.caller[key] !== undefined && layers.caller[key] !== file.values[key]),
  }
}

/** The workspace settings the environment still names, which a node on the workspace model ignores. */
export function environmentWorkspaceKeys(environment: NodeJS.ProcessEnv = process.env): string[] {
  return WORKSPACE_ENVIRONMENT_KEYS.filter(key => environment[key] !== undefined)
}

/**
 * The folder a node set up before the workspace model served, as the disk names it: BUCKLE_WORKSPACE_ROOT, or the
 * directory the command runs in. Refused where it is a whole drive, or where it holds the state directory, which an
 * agent writing anywhere in its workspace could then rewrite. Migration takes it as workspace default's folder (Q15).
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
  id: string
  name: string
  /** The workspace's folder, as the disk names it. */
  dir: string
  /** Where the agent sees the folder, from its mount table; null shows the real path. */
  mount: string | null
  policy: WorkspacePolicy
  packs: { enabled: string[] | null; shell: boolean; code: boolean; hostGit: boolean; hostLsp: boolean }
  /** Milliseconds a gated call is held for an answer; 0 holds it until someone answers. */
  approvalWaitMs: number
  /** Variables its shell commands see. */
  env: Readonly<Record<string, string>>
}

/**
 * One workspace's runtime configuration (D83): the node's settings, then the workspace's own. Workspace default, the
 * node's own folder, keeps its state in the node's directory; every other workspace has a state directory of its own.
 * Each takes the node's BUCKLE_SCRATCH_ROOTS, BUCKLE_MOUNTS, BUCKLE_SKILLS_DIRS, and BUCKLE_STRICT_WRITES until the mount
 * table holds them per workspace (fix brief 1, F; finding 43 of the Phase 1 review): they gave workspace default alone
 * what the docs say every workspace gets, and a node set up fresh has no default.
 */
export function workspaceConfig(node: NodeConfig, scope: WorkspaceScope): BuckleConfig {
  return {
    ...node,
    cwd: scope.dir,
    serverName: scope.name,
    stateDirectory: scope.id === NODE_FOLDER_WORKSPACE ? node.stateDirectory : join(node.stateDirectory, 'workspaces', scope.id),
    nodeStateDirectory: node.stateDirectory,
    ...workspaceFields(scope),
  }
}

/** The fields of a workspace's configuration its workspace.json decides, which a running workspace takes up between calls (Q2). */
export type WorkspaceFields = Pick<BuckleConfig, 'policy' | 'enabledPacks' | 'enableShell' | 'allowCode' | 'allowHostGit' | 'allowHostLsp' | 'approvalTimeoutMs' | 'commandEnvironment'>

export function workspaceFields(scope: Pick<WorkspaceScope, 'mount' | 'policy' | 'packs' | 'approvalWaitMs' | 'env'>): WorkspaceFields {
  return {
    policy: { ...scope.policy, mount: scope.mount },
    enabledPacks: scope.packs.enabled === null ? undefined : [...scope.packs.enabled],
    enableShell: scope.packs.shell,
    allowCode: scope.packs.code,
    allowHostGit: scope.packs.hostGit,
    allowHostLsp: scope.packs.hostLsp,
    approvalTimeoutMs: scope.approvalWaitMs === 0 ? null : scope.approvalWaitMs,
    commandEnvironment: { ...scope.env },
  }
}

/** A workspace's own state directory, and the node's when they differ. */
type StateDirectories = Pick<BuckleConfig, 'stateDirectory'> & Partial<Pick<BuckleConfig, 'nodeStateDirectory'>>

/**
 * Node configuration and all workspace maps are owner-only, never tool-accessible. Effects are judged
 * at their real paths, so each root is named by its real path too (a symlinked home, macOS /var), in
 * the case the disk stores it (realpathSync.native); the rule folds case where the disk ignores it.
 */
export function protectedStateRoots(config: StateDirectories): string[] {
  const named = [join(homeDirectory(), '.5straps'), config.nodeStateDirectory ?? config.stateDirectory]
  return [...new Set([...named, ...named.map(path => realPathOf(path))])]
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

/** The real path of a directory, or of its nearest existing ancestor with the rest appended. */
export function realPathOf(path: string, platform: NodeJS.Platform = process.platform): string {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    const parent = parentDirectory(path)
    return parent === path ? path : childPath(realPathOf(parent, platform), basename(path))
  }
  return nativePath(real, platform)
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
    throw new Error('BUCKLE_RINGS_APPROVAL_KEY is not a key Rings minted; remove it and pair the node with Rings again')
  }
}

/**
 * The policy a node set up before the workspace model kept in its environment, migration input only (Q14). Patterns
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
  if (value === 'forever') throw new Error('Invalid BUCKLE_APPROVAL_TIMEOUT_MS: forever; use 0 to wait until someone answers')
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
export function parseBrowserSettings(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Pick<NodeConfig, 'browserCdp' | 'browserProfile' | 'browserArgs'> {
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

/**
 * A DevTools port, or a ws://, wss://, http://, or https:// URL, as agent-browser's `--cdp` takes them. agent-browser
 * reads the scheme in lower case only and quotes the whole value when it cannot, so the scheme is lowered here.
 */
function parseBrowserCdp(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN
  if (port >= 1 && port <= 65_535) return raw
  const scheme = /^(?:wss?|https?):\/\//i.exec(raw)?.[0]
  if (scheme && URL.canParse(raw)) return `${scheme.toLowerCase()}${raw.slice(scheme.length)}`
  throw new Error('Invalid BUCKLE_BROWSER_CDP: expected a DevTools port such as 9222, or a ws://, wss://, http://, or https:// URL')
}

/** Absolute, so it names one folder whatever directory a command starts in. Where it lies is judged when the pack is built. */
function parseBrowserProfile(value: string | undefined, platform: NodeJS.Platform): string | undefined {
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
function parseBrowserArgs(value: string | undefined, platform: NodeJS.Platform): string | undefined {
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

export function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`)
  return parsed
}
