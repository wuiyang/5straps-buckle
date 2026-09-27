import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { workspaceEnvironmentFile } from './workspace-config.js'

// A line that sets a BUCKLE_ variable; matched by name only, so no value is ever read.
const BUCKLE_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?BUCKLE_\w*[ \t]*=/m

export function environmentFilePath(): string | null {
  return workspaceEnvironmentFile({ cwd: process.cwd(), explicit: process.env.BUCKLE_ENV_FILE })
}

/**
 * Only BUCKLE_* names are taken, and a variable already in the environment wins, so an operator
 * override still applies.
 */
export function loadEnvironmentFile(): void {
  const path = environmentFilePath()
  if (!path) return refuseUnreadDotEnv(process.cwd())
  if (!existsSync(path)) return
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (name.startsWith('BUCKLE_') && process.env[name] === undefined) process.env[name] = value
  }
}

// Buckle no longer reads <cwd>/.env; starting on defaults beside one that configures it would
// silently drop the owner's deny lists, packs and state directory.
function refuseUnreadDotEnv(cwd: string): void {
  const file = join(cwd, '.env')
  if (!existsSync(file) || !BUCKLE_ASSIGNMENT.test(readFileSync(file, 'utf8'))) return
  throw new Error(`${file} sets BUCKLE_ variables, but Buckle reads only BUCKLE_ENV_FILE or a registered workspace's file. Set BUCKLE_ENV_FILE to that file, or run \`buckle init\` here to create and register one.`)
}
