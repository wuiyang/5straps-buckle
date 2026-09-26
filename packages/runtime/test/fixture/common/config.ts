import { isAbsolute } from 'node:path'

export interface FixtureConfig {
  dataDir: string
  agentToken: string
  adminToken: string
  startupDelayMs: number
  startupFails: boolean
  closeStepTimeoutMs: number
}

const TOKEN = /^[\w-]{16,256}$/

// Startup-resolved configuration; nothing here is baked into the Nitro build.
export function loadConfig(env: NodeJS.ProcessEnv): FixtureConfig {
  const dataDir = required(env, 'FIXTURE_DATA_DIR')
  if (!isAbsolute(dataDir)) throw new TypeError('FIXTURE_DATA_DIR must be an absolute path')
  return {
    dataDir,
    agentToken: token(env, 'FIXTURE_AGENT_TOKEN'),
    adminToken: token(env, 'FIXTURE_ADMIN_TOKEN'),
    startupDelayMs: integer(env, 'FIXTURE_STARTUP_DELAY_MS', 0),
    startupFails: env.FIXTURE_STARTUP_FAILS === 'true',
    closeStepTimeoutMs: integer(env, 'FIXTURE_CLOSE_STEP_TIMEOUT_MS', 2_000),
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function token(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (!TOKEN.test(value)) throw new TypeError(`${name} must be 16 to 256 word characters`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return value
}
