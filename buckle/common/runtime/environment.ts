import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import { parseEnv } from 'node:util'
import { isOpenToOthers } from '../adapters/file-modes.js'
import { isInside, nativePath, typedPath } from '../domain/paths.js'
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
  const named = environment.BUCKLE_ENV_FILE
  if (!named) return defaultEnvironmentFile(environment)
  // Relative, it would name another file in every directory a command starts in (review L9 of B18-B19).
  if (!isAbsolute(named)) throw new Error(`BUCKLE_ENV_FILE must be an absolute path, not ${named}: Buckle never resolves its settings against the working directory`)
  return typedPath(named)
}

/** buckle.env in the state directory the process environment names. */
export function defaultEnvironmentFile(environment: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirectoryOf(environment), ENVIRONMENT_FILE_NAME)
}

export interface LoadedEnvironmentFile {
  file: string | null
  /** Group or other permission bits are set on a file that holds the node's credentials; never on Windows, which keeps no modes. */
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
  refuseNamedEnvironmentFile({ file: path, variables: Object.fromEntries(variables) })
  if (!explicit) refuseMovedStateDirectory({ file: path, variables: Object.fromEntries(variables) })
  for (const [name, value] of variables) {
    if (process.env[name] === undefined) process.env[name] = value
  }
  return { file: path, openToOthers: isOpenToOthers(path) }
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

/** Whether the process environment itself chose the node before its file loaded: BUCKLE_ENV_FILE or BUCKLE_WORKSPACE_ROOT. */
export function namesItsNode(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.BUCKLE_ENV_FILE || environment.BUCKLE_WORKSPACE_ROOT)
}

/**
 * One node per state directory (review M4 of B18-B19): `buckle mcp`, or a command that runs a tool
 * (`buckle call`, `buckle <group> <verb>`), started in a project outside the file's workspace root
 * serves that root, not the project. Null when the process environment named its node, or the
 * working directory is inside the root.
 */
export function outsideRootNotice(input: { namedNode: boolean; root: string; cwd: string; file: string | null }): string | null {
  if (input.namedNode || isInside(realPath(input.root), realPath(input.cwd))) return null
  const source = input.file ? `the workspace root ${input.file} sets` : 'its workspace root'
  return `Buckle serves ${input.root}, ${source}, but started in ${input.cwd}, outside it: this project gets that root's files, grants and history. To give this project its own node, set BUCKLE_ENV_FILE to its own environment file, or BUCKLE_WORKSPACE_ROOT and BUCKLE_STATE_DIR, in the shell or the MCP config's env.`
}

function realPath(path: string): string {
  try { return nativePath(realpathSync(path)) } catch { return resolve(path) }
}

/** Owner decision D5: a project outside the root is warned, not refused. A later ruling flips it here: throw new Error(notice). */
export function meetOutsideRoot(notice: string): void {
  process.stderr.write(`Warning: ${notice}\n`)
}
