import { parseSandboxMounts, type SandboxMount } from '../domain/sandbox-mounts.js'
import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join } from 'pathe'
import { emptyWorkspacePolicy, SandboxModeSchema, type WorkspacePolicy } from '@5straps/protocol'
import { approvalKey, type ApprovalKey } from '@5straps/protocol/envelope'
import { INTERPRETER_NAMES, isInterpreter } from '../domain/command-forms.js'
import { homeDirectory, isInside, isInsideComparable, nativePath, parentDirectory, typedPath, workingDirectory } from '../domain/paths.js'
import { compileHostPattern, UrlPatternError } from '../domain/url-pattern.js'

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TIMEOUT_MS = 300_000
const DEFAULT_APPROVAL_TIMEOUT_MS = 15_000
const DEFAULT_FORGE_API_URL = 'https://api.github.com'
const DEFAULT_FORGE_GIT_AUTHOR = '5straps agent <agent@5straps.local>'
const GIT_AUTHOR_PATTERN = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/

export interface BuckleConfig {
  host: string
  port: number
  serverId: string
  serverName: string
  description: string
  usage: string
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
  cwd: string
  /** Directories writable without asking. Empty by default, so the first write anywhere asks. */
  scratchRoots: string[]
  strictWrites: boolean
  sandboxMode: 'auto' | 'none' | 'bubblewrap' | 'seatbelt'
  acknowledgedUnsandboxed: boolean
  enabledPacks?: string[]
  historyMaxBytes: number
  historyRetentionDays: number
  allowHostGit: boolean
  allowHostLsp: boolean
  enableShell: boolean
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
  /** How long a gated call is held for an answer, in milliseconds; null holds it until someone answers (BUCKLE_APPROVAL_TIMEOUT_MS=0). */
  approvalTimeoutMs: number | null
  /** Where to announce a pending approval, so a person can be reached away from the machine. */
  approvalWebhook?: string
  /** The owner's constraints from the environment. Merged with what `buckle policy` or Rings stored. */
  policy: WorkspacePolicy
  /** Immutable installation policy, enforced independently for managed child workspaces. */
  nodePolicy?: WorkspacePolicy
  /** Owner-authorized read-only file and folder aliases, scoped to the default workspace. */
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
  nodeStateDirectory?: string
  /** How long a state file update waits for another process's lock; the store's default when absent. Never read from the environment. */
  stateLockDeadlineMs?: number
  maxRequestBytes: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BuckleConfig {
  // Named as the disk names it (realpathSync.native), as every judged effect path is: a root typed in
  // another case than the disk's put every existing file outside it on macOS (review M1 of the second
  // proof-of-possession re-review), and a linked root put every file outside it everywhere.
  const typedRoot = environment.BUCKLE_WORKSPACE_ROOT ? typedPath(environment.BUCKLE_WORKSPACE_ROOT) : workingDirectory()
  const cwd = realPathOf(typedRoot)
  const stateDirectory = stateDirectoryOf(environment)
  if (workspaceHolds(typedRoot, stateDirectory)) {
    throw new Error(`BUCKLE_STATE_DIR is ${stateDirectory}, inside the BUCKLE_WORKSPACE_ROOT at ${cwd}: an agent writes anywhere in the workspace, and the state directory holds the recorded grants, the approvals and the empty hooks directory the forge tools run git with`)
  }

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
    cwd,
    // As the disk names each, as the workspace root is: a judged effect path is real and in the disk's case.
    scratchRoots: parseList(environment.BUCKLE_SCRATCH_ROOTS).map(root => realPathOf(typedPath(root))),
    strictWrites: environment.BUCKLE_STRICT_WRITES === 'true',
    sandboxMode,
    acknowledgedUnsandboxed: sandboxMode === 'none',
    enabledPacks: environment.BUCKLE_PACKS ? parseList(environment.BUCKLE_PACKS) : undefined,
    historyMaxBytes: parsePositiveInteger(environment.BUCKLE_HISTORY_MAX_BYTES, 1_073_741_824),
    historyRetentionDays: parsePositiveInteger(environment.BUCKLE_HISTORY_RETENTION_DAYS, 30),
    allowHostGit: environment.BUCKLE_ALLOW_HOST_GIT === 'true',
    allowHostLsp: environment.BUCKLE_ALLOW_HOST_LSP === 'true',
    enableShell: environment.BUCKLE_ALLOW_SHELL !== 'false',
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
    agentBrowserCommand: environment.BUCKLE_AGENT_BROWSER_COMMAND ?? 'agent-browser',
    browserHeaded: environment.BUCKLE_BROWSER_HEADED === 'true',
    approvalTimeoutMs: parseApprovalTimeout(environment.BUCKLE_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS),
    approvalWebhook: environment.BUCKLE_APPROVAL_WEBHOOK || undefined,
    policy: parsePolicy(environment),
    sandboxMounts: parseSandboxMounts(environment.BUCKLE_MOUNTS),
    mountReadOnlyPaths: parseList(environment.BUCKLE_MOUNT_READ_ONLY).map(path => typedPath(path)),
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
 * Node configuration and all workspace maps are owner-only, never tool-accessible. Effects are judged
 * at their real paths, so each root is named by its real path too (a symlinked home, macOS /var), in
 * the case the disk stores it (realpathSync.native); the rule folds case where the disk ignores it.
 */
export function protectedStateRoots(config: Pick<BuckleConfig, 'stateDirectory' | 'nodeStateDirectory'>): string[] {
  const named = [join(homeDirectory(), '.5straps'), config.nodeStateDirectory ?? config.stateDirectory]
  return [...new Set([...named, ...named.map(realPathOf)])]
}

/**
 * Whether a workspace root holds a path, as typed and where each really is, compared as the disk compares: a root or
 * a state directory spelled through a link, or in another case where the disk ignores case, must not start a node
 * whose state an agent can write (review M3). `buckle init` refuses by the same test.
 */
export function workspaceHolds(typedRoot: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const root = realPathOf(typedRoot)
  return isInside(typedRoot, path, platform) || isInside(root, path, platform) || isInsideComparable(root, realPathOf(path), platform === 'darwin' || platform === 'win32', platform)
}

/** The real path of a directory, or of its nearest existing ancestor with the rest appended. */
function realPathOf(path: string): string {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    const parent = parentDirectory(path)
    return parent === path ? path : join(realPathOf(parent), basename(path))
  }
  return nativePath(real)
}

/** Where grants, approvals and the action log live, read without loading the rest of the config. */
export function stateDirectoryOf(environment: NodeJS.ProcessEnv): string {
  const named = environment.BUCKLE_STATE_DIR
  if (!named) return join(homeDirectory(), '.5straps', 'buckle')
  // Relative, it would name another directory in every directory a command starts in (review L13 of B20-B22).
  if (!isAbsolute(named)) throw new Error(`BUCKLE_STATE_DIR must be an absolute path, not ${named}: Buckle never resolves its state against the working directory`)
  return typedPath(named)
}

/** The HTTP face exposes tools over the network, so it refuses to start without a token. */
export function requireAuthToken(config: BuckleConfig): string {
  if (!config.authToken) throw new Error('BUCKLE_AUTH_TOKEN is required to serve over HTTP')
  return config.authToken
}

export function grantsPath(config: BuckleConfig): string {
  return join(config.stateDirectory, 'grants.json')
}

export function pluginsPath(config: BuckleConfig): string {
  return join(config.stateDirectory, 'plugins.json')
}

export function approvalsPath(config: BuckleConfig): string {
  return join(config.stateDirectory, 'approvals.json')
}

export function approvalNoncesPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'approval-nonces.json')
}

export function actionsPath(config: Pick<BuckleConfig, 'stateDirectory'>): string {
  return join(config.stateDirectory, 'actions.jsonl')
}

export function policyPath(config: BuckleConfig): string {
  return join(config.stateDirectory, 'policy.json')
}

/** The client keys the owner enrolled on this node (owner ruling H4 of 2026-09-28): one list per node, beside its registry. */
export function clientKeysPath(config: Pick<BuckleConfig, 'stateDirectory' | 'nodeStateDirectory'>): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'client-keys.json')
}

/** The nonces of signed requests this node verified, so none lands twice inside its window. */
export function requestNoncesPath(config: Pick<BuckleConfig, 'stateDirectory' | 'nodeStateDirectory'>): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'request-nonces.json')
}

/** The node's own signing key, which signs what it shows a person's client (B24). */
export function nodeKeyPath(config: Pick<BuckleConfig, 'stateDirectory' | 'nodeStateDirectory'>): string {
  return join(config.nodeStateDirectory ?? config.stateDirectory, 'node-signing-key.pem')
}

/** The setup sessions persons' keys opened on this node (B24). */
export function setupSessionsPath(config: Pick<BuckleConfig, 'stateDirectory' | 'nodeStateDirectory'>): string {
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
 * The environment's share of the policy. Patterns are shell-word globs, one per line or
 * separated by `;;`. BUCKLE_ALLOWED_INTERPRETERS names, comma separated, the interpreters read as
 * ordinary commands: for the node's own workspace beside what `buckle policy` stores, and as the
 * node ceiling's list, within which alone a registered workspace's allowance counts (docs/dev/architecture.md,
 * Interpreters).
 */
function parsePolicy(environment: NodeJS.ProcessEnv): WorkspacePolicy {
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

function parseSandboxMode(value: string | undefined): BuckleConfig['sandboxMode'] {
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
