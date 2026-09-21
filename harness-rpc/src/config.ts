import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { emptyWorkspacePolicy, SandboxModeSchema, type WorkspacePolicy } from '@5straps/protocol'
import { isInside } from './domain/paths.js'
import { logger } from './logger.js'

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
  cwd: string
  /** Directories writable without asking. Empty by default, so the first write anywhere asks. */
  scratchRoots: string[]
  strictWrites: boolean
  sandboxMode: 'auto' | 'none' | 'bubblewrap' | 'seatbelt'
  acknowledgedUnsandboxed: boolean
  enabledPacks?: string[]
  historyMaxBytes: number
  historyRetentionDays: number
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
  /** How long a gated call waits for a decision before reporting back. Zero refuses at once. */
  approvalTimeoutMs: number
  /** Where to announce a pending approval, so a person can be reached away from the machine. */
  approvalWebhook?: string
  /** The owner's constraints from the environment. Merged with what `buckle policy` or Rings stored. */
  policy: WorkspacePolicy
  /** Immutable installation policy, enforced independently for managed child workspaces. */
  nodePolicy?: WorkspacePolicy
  /** Host directories still readable inside a mounted sandbox, for toolchains outside /usr. */
  mountReadOnlyPaths: string[]
  /** Where every refused call is posted as it happens. Rings, usually. */
  reportUrl?: string
  reportToken?: string
  skillDirectories: string[]
  stateDirectory: string
  nodeStateDirectory?: string
  maxRequestBytes: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BuckleConfig {
  const cwd = resolve(environment.BUCKLE_WORKSPACE_ROOT ?? process.cwd())
  const stateDirectory = environment.BUCKLE_STATE_DIR
    ? resolve(environment.BUCKLE_STATE_DIR)
    : join(homedir(), '.5straps', 'buckle')
  if (isInside(cwd, stateDirectory)) {
    throw new Error(`BUCKLE_STATE_DIR is ${stateDirectory}, inside the BUCKLE_WORKSPACE_ROOT at ${cwd}: an agent writes anywhere in the workspace, and the state directory holds the recorded grants, the approvals and the empty hooks directory the forge tools run git with`)
  }

  const sandboxMode = parseSandboxMode(environment.BUCKLE_SANDBOX)
  const authToken = environment.BUCKLE_AUTH_TOKEN ?? ''
  const adminToken = parseAdminToken(environment)
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
    scratchRoots: parseList(environment.BUCKLE_SCRATCH_ROOTS).map(root => resolve(root)),
    strictWrites: environment.BUCKLE_STRICT_WRITES === 'true',
    sandboxMode,
    acknowledgedUnsandboxed: sandboxMode === 'none',
    enabledPacks: environment.BUCKLE_PACKS ? parseList(environment.BUCKLE_PACKS) : undefined,
    historyMaxBytes: parsePositiveInteger(environment.BUCKLE_HISTORY_MAX_BYTES, 1_073_741_824),
    historyRetentionDays: parsePositiveInteger(environment.BUCKLE_HISTORY_RETENTION_DAYS, 30),
    allowHostLsp: environment.BUCKLE_ALLOW_HOST_LSP === 'true',
    enableShell: environment.BUCKLE_ALLOW_SHELL !== 'false',
    shellNetwork: environment.BUCKLE_SHELL_NETWORK === 'true',
    isolateShell: environment.BUCKLE_SHELL_ISOLATION !== 'false',
    isolationMaxBytes: parsePositiveInteger(environment.BUCKLE_ISOLATION_MAX_BYTES, 268_435_456),
    environmentValidator: environment.BUCKLE_ENV_VALIDATOR_COMMAND || undefined,
    allowedHosts: parseList(environment.BUCKLE_ALLOWED_HOSTS),
    braveSearchApiKey: environment.BUCKLE_BRAVE_SEARCH_API_KEY || undefined,
    forgeGithubToken: environment.BUCKLE_FORGE_GITHUB_TOKEN || undefined,
    forgeApiUrl: parseForgeApiUrl(environment.BUCKLE_FORGE_GITHUB_API_URL),
    forgeGitAuthor: parseGitAuthor(environment.BUCKLE_FORGE_GIT_AUTHOR),
    agentBrowserCommand: environment.BUCKLE_AGENT_BROWSER_COMMAND ?? 'agent-browser',
    browserHeaded: environment.BUCKLE_BROWSER_HEADED === 'true',
    approvalTimeoutMs: parseTimeout(environment.BUCKLE_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS),
    approvalWebhook: environment.BUCKLE_APPROVAL_WEBHOOK || undefined,
    policy: parsePolicy(environment),
    mountReadOnlyPaths: parseList(environment.BUCKLE_MOUNT_READ_ONLY).map(path => resolve(path)),
    reportUrl: environment.BUCKLE_REPORT_URL || undefined,
    reportToken: environment.BUCKLE_REPORT_TOKEN || undefined,
    skillDirectories: parseList(environment.BUCKLE_SKILLS_DIRS),
    stateDirectory,
    maxRequestBytes: parsePositiveInteger(environment.BUCKLE_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES),
    defaultTimeoutMs: parsePositiveInteger(environment.BUCKLE_DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: parsePositiveInteger(environment.BUCKLE_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS),
  }
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

export function actionsPath(config: BuckleConfig): string {
  return join(config.stateDirectory, 'actions.jsonl')
}

export function policyPath(config: BuckleConfig): string {
  return join(config.stateDirectory, 'policy.json')
}

/**
 * The admin credential, renamed from the setup token by `BUCKLE-08`. `BUCKLE_SETUP_TOKEN` is
 * still read for one release so an install written by an earlier `buckle init` keeps starting;
 * two different values are an error rather than a silent choice between two authorities.
 */
function parseAdminToken(environment: NodeJS.ProcessEnv): string {
  const adminToken = environment.BUCKLE_ADMIN_TOKEN?.trim() ?? ''
  const legacyToken = environment.BUCKLE_SETUP_TOKEN?.trim() ?? ''
  if (adminToken && legacyToken && adminToken !== legacyToken) {
    throw new Error('BUCKLE_ADMIN_TOKEN and BUCKLE_SETUP_TOKEN hold different values: keep BUCKLE_ADMIN_TOKEN and remove the old name')
  }
  if (!adminToken && legacyToken) logger.warn('BUCKLE_SETUP_TOKEN is the old name for BUCKLE_ADMIN_TOKEN and is read for one release; rename it')
  return adminToken || legacyToken
}

/**
 * The environment's share of the policy. Patterns are shell-word globs, one per line or
 * separated by `;;`.
 */
function parsePolicy(environment: NodeJS.ProcessEnv): WorkspacePolicy {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = parsePatterns(environment.BUCKLE_COMMAND_ALLOW)
  policy.commands.deny = parsePatterns(environment.BUCKLE_COMMAND_DENY)
  policy.commands.destructive = parsePatterns(environment.BUCKLE_COMMAND_DESTRUCTIVE)
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

/** Unlike the other durations, zero is meaningful here: it turns the grace period off. */
function parseTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid BUCKLE_APPROVAL_TIMEOUT_MS: ${value}`)
  return parsed
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

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`)
  return parsed
}
