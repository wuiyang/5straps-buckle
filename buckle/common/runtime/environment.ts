import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import { parseEnv } from 'node:util'
import { isOpenToOthers } from '../adapters/file-modes.js'
import { isInside, typedPath } from '../domain/paths.js'
import { defaultEnvironmentFile, environmentFilePath, realPathOf, stateDirectoryOf } from './config.js'
import type { NodeLocation } from '../types/ports/service-manager.js'

// A line that sets a BUCKLE_ variable; matched by name only, so no value is ever read.
const BUCKLE_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?BUCKLE_\w*[ \t]*=/m

/** Why `buckle mcp` refuses a BUCKLE_ENV_FILE: the variable alone, never its value, which is the owner's path. */
export const FOREIGN_ENVIRONMENT_FILE = 'BUCKLE_ENV_FILE names a file outside the node\'s state directory, or no file: buckle mcp takes the node\'s settings only from its own buckle.env or a file in its state directory, as an MCP config\'s env may be within an agent\'s reach. Remove BUCKLE_ENV_FILE from the MCP config\'s env, or move the file into the state directory.'

/**
 * `buckle mcp` is started by an MCP client, from a config an agent may be able to write, so the file it takes the
 * node's settings from, every workspace's deny lists among them, must be the node's own (fix brief 4, finding 7): the
 * default buckle.env, or a file in the state directory, which is owner-only and hidden from agents. Any other
 * BUCKLE_ENV_FILE, or one naming no file, is refused, naming the variable and never its value; a missing file would
 * otherwise leave the defaults to the caller's own environment. The owner's own commands keep honouring any file.
 */
export function refuseForeignEnvironmentFile(environment: NodeJS.ProcessEnv = process.env): void {
  const named = environment.BUCKLE_ENV_FILE
  if (!named || ownEnvironmentFile(named, environment)) return
  throw new Error(FOREIGN_ENVIRONMENT_FILE)
}

/** Whether a BUCKLE_ENV_FILE value names the default file, or a file that is there inside the state directory, where each really is. */
function ownEnvironmentFile(named: string, environment: NodeJS.ProcessEnv): boolean {
  if (!isAbsolute(named)) return false
  let path: string
  try { path = typedPath(named) } catch { return false }
  if (path === typedPath(defaultEnvironmentFile(environment))) return true
  if (!existsSync(path) || !statSync(path).isFile()) return false
  return isInside(realPathOf(stateDirectoryOf(environment)), realPathOf(path))
}

/**
 * Where the node lives, read before its environment file is loaded, so a command that starts another program (`buckle
 * service`, `buckle serve --background`) has no credential in its own environment. A file BUCKLE_ENV_FILE names may
 * move the state directory, as loadEnvironmentFile honours its BUCKLE_STATE_DIR line; that one line is read, by name,
 * and no other value of the file.
 */
export function nodeLocation(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeLocation {
  const environmentFile = environment.BUCKLE_ENV_FILE ? environmentFilePath(environment, platform) : null
  const named = environment.BUCKLE_STATE_DIR || (environmentFile !== null && existsSync(environmentFile) ? Object.fromEntries(buckleVariables(readFileSync(environmentFile, 'utf8'))).BUCKLE_STATE_DIR : undefined)
  return { stateDirectory: stateDirectoryOf({ ...environment, BUCKLE_STATE_DIR: named }, platform), environmentFile }
}

export interface LoadedEnvironmentFile {
  file: string | null
  /** Group or other permission bits are set on a file that holds the node's credentials; never on Windows, which keeps no modes. */
  openToOthers: boolean
  /** The file's own BUCKLE_ values, before the process environment was laid over them: what migration reads. */
  values: Readonly<Record<string, string>>
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
    return { file: null, openToOthers: false, values: {} }
  }
  const values = Object.freeze(Object.fromEntries(buckleVariables(readFileSync(path, 'utf8'))))
  refuseNamedEnvironmentFile({ file: path, variables: values })
  if (!explicit) refuseMovedStateDirectory({ file: path, variables: values })
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] === undefined) process.env[name] = value
  }
  return { file: path, openToOthers: isOpenToOthers(path), values }
}

/** An environment file's BUCKLE_ settings, the only names Buckle takes from one. */
export function buckleVariables(text: string): Array<[string, string]> {
  return Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[0].startsWith('BUCKLE_') && entry[1] !== undefined)
}

// Buckle never reads <cwd>/.env; starting on defaults beside one that configures it would silently
// drop the owner's deny lists, packs and state directory. The file is matched by variable name only.
function refuseUnreadDotEnv(input: { cwd: string; expected: string }): void {
  const file = join(input.cwd, '.env')
  if (!existsSync(file) || !BUCKLE_ASSIGNMENT.test(readFileSync(file, 'utf8'))) return
  throw new Error(`${file} sets BUCKLE_ variables, but Buckle never reads the working directory: its settings live in ${input.expected}, or in the file BUCKLE_ENV_FILE names. Run \`buckle init\` to write them there, or set BUCKLE_ENV_FILE to this file.`)
}

// An environment file cannot name another one: `buckle settings`, init and pairing would then edit a
// file other than the one serve read (review L9 of B18-B19).
function refuseNamedEnvironmentFile(input: { file: string; variables: Record<string, string | undefined> }): void {
  if (input.variables.BUCKLE_ENV_FILE === undefined) return
  throw new Error(`${input.file} sets BUCKLE_ENV_FILE, but an environment file cannot name another one. Remove the line, and set BUCKLE_ENV_FILE in the shell or in the MCP config's env.`)
}

// The file found in the state directory cannot move that directory: the node would keep its state in
// one place and its settings in another, and `buckle settings` would edit a file serve never reads.
function refuseMovedStateDirectory(input: { file: string; variables: Record<string, string | undefined> }): void {
  const named = input.variables.BUCKLE_STATE_DIR
  if (named === undefined || resolve(named) === dirname(input.file)) return
  throw new Error(`${input.file} sets BUCKLE_STATE_DIR to another directory, but the environment file in a state directory belongs to that directory. Remove the line and set BUCKLE_STATE_DIR in the shell, or name the file with BUCKLE_ENV_FILE.`)
}
