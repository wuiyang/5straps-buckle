import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { stateDirectoryOf } from './config.js'

/** The node's environment file in its state directory, which `buckle init` and pairing write. */
export const ENVIRONMENT_FILE_NAME = 'buckle.env'

// A line that sets a BUCKLE_ variable; matched by name only, so no value is ever read.
const BUCKLE_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?BUCKLE_\w*[ \t]*=/m

/**
 * Where the node's settings live: buckle.env in the state directory (BUCKLE_STATE_DIR from the
 * process environment, ~/.5straps/buckle by default), or the file BUCKLE_ENV_FILE names. The working
 * directory is never consulted: settings and credentials stay under the owner's state, away from any
 * project an agent works in.
 */
export function environmentFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.BUCKLE_ENV_FILE ? resolve(environment.BUCKLE_ENV_FILE) : defaultEnvironmentFile(environment)
}

/** buckle.env in the state directory the process environment names. */
export function defaultEnvironmentFile(environment: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirectoryOf(environment), ENVIRONMENT_FILE_NAME)
}

export interface LoadedEnvironmentFile {
  file: string | null
  /** Group or other permission bits are set on a file that holds the node's credentials. */
  openToOthers: boolean
}

/**
 * Only BUCKLE_* names are taken, and a variable already in the environment wins, so an operator
 * override still applies.
 */
export function loadEnvironmentFile(): LoadedEnvironmentFile {
  const path = environmentFilePath()
  const explicit = Boolean(process.env.BUCKLE_ENV_FILE)
  if (!existsSync(path)) {
    if (!explicit) refuseUnreadDotEnv({ cwd: process.cwd(), expected: path })
    return { file: null, openToOthers: false }
  }
  const variables = Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter(([name]) => name.startsWith('BUCKLE_'))
  if (!explicit) refuseMovedStateDirectory({ file: path, variables: Object.fromEntries(variables) })
  for (const [name, value] of variables) {
    if (process.env[name] === undefined) process.env[name] = value
  }
  return { file: path, openToOthers: (statSync(path).mode & 0o077) !== 0 }
}

// Buckle never reads <cwd>/.env; starting on defaults beside one that configures it would silently
// drop the owner's deny lists, packs and state directory. The file is matched by variable name only.
function refuseUnreadDotEnv(input: { cwd: string; expected: string }): void {
  const file = join(input.cwd, '.env')
  if (!existsSync(file) || !BUCKLE_ASSIGNMENT.test(readFileSync(file, 'utf8'))) return
  throw new Error(`${file} sets BUCKLE_ variables, but Buckle never reads the working directory: its settings live in ${input.expected}, or in the file BUCKLE_ENV_FILE names. Run \`buckle init\` to write them there, or set BUCKLE_ENV_FILE to this file.`)
}

// The file found in the state directory cannot move that directory: the node would keep its state in
// one place and its settings in another, and `buckle settings` would edit a file serve never reads.
function refuseMovedStateDirectory(input: { file: string; variables: Record<string, string | undefined> }): void {
  const named = input.variables.BUCKLE_STATE_DIR
  if (named === undefined || resolve(named) === dirname(input.file)) return
  throw new Error(`${input.file} sets BUCKLE_STATE_DIR to another directory, but the environment file in a state directory belongs to that directory. Remove the line and set BUCKLE_STATE_DIR in the shell, or name the file with BUCKLE_ENV_FILE.`)
}
