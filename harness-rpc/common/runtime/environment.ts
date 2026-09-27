import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { workspaceEnvironmentFile } from './workspace-config.js'

export function environmentFilePath(): string | null {
  return workspaceEnvironmentFile({ cwd: process.cwd(), explicit: process.env.BUCKLE_ENV_FILE })
}

/**
 * Only BUCKLE_* names are taken, and a variable already in the environment wins, so an operator
 * override still applies.
 */
export function loadEnvironmentFile(): void {
  const path = environmentFilePath()
  if (!path || !existsSync(path)) return
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (name.startsWith('BUCKLE_') && process.env[name] === undefined) process.env[name] = value
  }
}
