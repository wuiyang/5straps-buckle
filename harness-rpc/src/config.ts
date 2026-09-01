import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { SandboxModeSchema } from '@5straps/protocol'

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TIMEOUT_MS = 300_000

export interface BuckleConfig {
  host: string
  port: number
  serverId: string
  serverName: string
  description: string
  usage: string
  authToken: string
  cwd: string
  /** Directories writable without asking. Empty by default, so the first write anywhere asks. */
  scratchRoots: string[]
  strictWrites: boolean
  sandboxMode: 'auto' | 'none' | 'bubblewrap' | 'seatbelt'
  acknowledgedUnsandboxed: boolean
  enableShell: boolean
  allowedHosts: string[]
  braveSearchApiKey?: string
  agentBrowserCommand: string
  skillDirectories: string[]
  stateDirectory: string
  maxRequestBytes: number
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BuckleConfig {
  const stateDirectory = environment.BUCKLE_STATE_DIR
    ? resolve(environment.BUCKLE_STATE_DIR)
    : join(homedir(), '.5straps', 'buckle')

  const sandboxMode = parseSandboxMode(environment.BUCKLE_SANDBOX)

  return {
    host: environment.BUCKLE_HOST ?? '127.0.0.1',
    port: parsePositiveInteger(environment.BUCKLE_PORT, 4320),
    serverId: environment.BUCKLE_SERVER_ID ?? 'local-dev',
    serverName: environment.BUCKLE_SERVER_NAME ?? 'Local Buckle',
    description: environment.BUCKLE_DESCRIPTION ?? '',
    usage: environment.BUCKLE_USAGE ?? '',
    authToken: environment.BUCKLE_AUTH_TOKEN ?? '',
    cwd: resolve(environment.BUCKLE_WORKSPACE_ROOT ?? process.cwd()),
    scratchRoots: parseList(environment.BUCKLE_SCRATCH_ROOTS).map(root => resolve(root)),
    strictWrites: environment.BUCKLE_STRICT_WRITES === 'true',
    sandboxMode,
    acknowledgedUnsandboxed: sandboxMode === 'none',
    enableShell: environment.BUCKLE_ALLOW_SHELL !== 'false',
    allowedHosts: parseList(environment.BUCKLE_ALLOWED_HOSTS),
    braveSearchApiKey: environment.BUCKLE_BRAVE_SEARCH_API_KEY || undefined,
    agentBrowserCommand: environment.BUCKLE_AGENT_BROWSER_COMMAND ?? 'agent-browser',
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

function parseSandboxMode(value: string | undefined): BuckleConfig['sandboxMode'] {
  if (!value || value === 'auto') return 'auto'
  const parsed = SandboxModeSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Invalid BUCKLE_SANDBOX: ${value}`)
  return parsed.data
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
