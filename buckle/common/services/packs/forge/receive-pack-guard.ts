import { randomBytes } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setMode } from '../../../adapters/file-modes.js'
import { ToolExecutionError } from '../../../domain/tool.js'
import { receivePackCommand } from '../git-isolation.js'
import { MAX_ENTRIES, POINTER_FILES, REF_DIRECTORIES } from './own-git-directory.js'

/** Buckle-owned, and where the receiving git of a local push finds its hooks: the guard below, and nothing else. */
const RECEIVE_HOOKS_DIRECTORY = 'receive-git-hooks'
/**
 * What the guard and the receiving command write before their reason, around the push's nonce: `<BEFORE_NONCE><nonce>
 * <AFTER_NONCE><reason>`. Only Buckle knows the nonce, so a destination's own text (a config value git quotes when it
 * fails to parse it) is never read as Buckle's refusal (slice 7c review RGC-1).
 */
const BEFORE_NONCE = 'Buckle refused the push in the receiving git (push '
const AFTER_NONCE = '): '

/**
 * The receiving git's pre-receive hook (slice 7 review F3). The checks before a local push hold only the pushing
 * workspace's lock, so a write from another workspace could plant a `.git` pointer in the destination after them
 * (1 of 40 races landed in the repository it named). receive-pack runs this hook once it has opened a repository
 * and received the pack into quarantine, before it writes any ref, in the git directory it opened: so the test is
 * of the repository git really writes. It refuses unless that directory and the quarantine's object store are the
 * git directory the checks before the push found, and repeats ownGitDirectory there; a refusal drops the
 * quarantined objects, and no ref is written. Written without a backslash, so it survives being quoted for a shell.
 * Its stdin carries the ref updates and is not read; it writes only to stderr, which git shows as `remote:` lines.
 */
const GUARD_SOURCE = `'use strict'
const { lstatSync, readdirSync, realpathSync } = require('node:fs')
const { dirname, join } = require('node:path')
const NEWLINE = String.fromCharCode(10)
const { BUCKLE_RECEIVE_REPOSITORY: repository, BUCKLE_RECEIVE_GIT_DIRECTORY: gitDirectory, BUCKLE_RECEIVE_REMEDY: remedy, BUCKLE_RECEIVE_NONCE: nonce, GIT_QUARANTINE_PATH: quarantine } = process.env
const refuse = (problem) => {
  process.stderr.write(${JSON.stringify(BEFORE_NONCE)} + nonce + ${JSON.stringify(AFTER_NONCE)} + problem + ', so git would write somewhere the permission rules never judged; ' + (remedy || 'push to the real repository by its own path') + NEWLINE)
  process.exit(1)
}
const statOf = (path) => { try { return lstatSync(path) } catch { return null } }
const realPathOf = (path) => { try { return realpathSync.native(path) } catch { return null } }
if (!repository || !gitDirectory || !nonce) refuse('the push named no checked destination')
const opened = realPathOf(process.cwd())
if (opened !== gitDirectory) refuse('receive-pack opened ' + opened + ', not the git directory ' + gitDirectory + ' checked before the push')
if (quarantine && realPathOf(dirname(quarantine)) !== realPathOf(join(gitDirectory, 'objects'))) refuse('receive-pack stores the pushed objects in ' + dirname(quarantine) + ', outside ' + gitDirectory)
if (!statOf(repository)?.isDirectory()) refuse(repository + ' is not a directory')
const dotGit = join(repository, '.git')
const pointer = statOf(dotGit)
if (pointer?.isSymbolicLink()) refuse(dotGit + ' is a symbolic link')
if (pointer && !pointer.isDirectory()) refuse(dotGit + ' is a file pointing git at another repository')
const directory = pointer ? dotGit : repository
if (directory !== gitDirectory) refuse(directory + ' became the git directory after the push was checked against ' + gitDirectory)
for (const name of ${JSON.stringify(POINTER_FILES)}) {
  if (statOf(join(directory, name))) refuse(join(directory, name) + ' points git at another repository')
}
let remaining = ${MAX_ENTRIES}
const firstLink = (path, depth) => {
  let entries
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return null }
  remaining -= entries.length
  if (remaining < 0) refuse(directory + ' holds more than ${MAX_ENTRIES} entries to check')
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) return child
    if (!entry.isDirectory() || depth <= 1) continue
    const found = firstLink(child, depth - 1)
    if (found !== null) return found
  }
  return null
}
const scans = [[directory, 1], [join(directory, 'objects'), 1], ...${JSON.stringify(REF_DIRECTORIES)}.map(name => [join(directory, name), Infinity])]
for (const [path, depth] of scans) {
  const linked = firstLink(path, depth)
  if (linked !== null) refuse(linked + ' is a symbolic link')
}
`

/**
 * The `--receive-pack` command of a push to a repository on this filesystem: git's receive-pack with the receiving
 * isolation and Buckle's guard as its only hook (ensureReceiveGuard), started only while that hook can run. Git skips
 * a hook it cannot execute with a hint and no failure, so the command tests the execute bit itself first and refuses
 * without it (slice 7b review RG-1): a hook that lost its mode after the checks, or a state directory on a noexec
 * mount, fails the push closed. Git runs the command through a shell and appends the destination's path to it. The
 * refusal carries the push's nonce from the environment, and is written with printf, since dash's echo reads a
 * backslash in the state path as an escape and cut the text (slice 7c review RGC-2).
 */
export function guardedReceivePackCommand(stateDirectory: string): string {
  const directory = ensureReceiveGuard(stateDirectory)
  const hook = join(directory, 'pre-receive')
  const reason = `its guard ${hook} cannot be run, so git would skip it and could write somewhere the permission rules never judged; restore the file's execute permission, or keep Buckle's state directory off a noexec mount`
  const refusal = `${shellQuoted(BEFORE_NONCE)}"$BUCKLE_RECEIVE_NONCE"${shellQuoted(`${AFTER_NONCE}${reason}`)}`
  return `test -x ${shellQuoted(hook)} || { printf '%s\\n' ${refusal} >&2; exit 1; }; exec ${receivePackCommand(directory)}`
}

/**
 * The hooks directory the receiving git of a local push is pointed at (receivingIsolationConfig's
 * `core.hooksPath`), holding only the guard as `pre-receive`, run by this process's own node. Written in
 * Buckle's state directory and replaced whole, so a push never runs a half-written hook. A guard without its
 * execute permission (a state directory restored or copied without modes, a umask that narrowed the mode it was
 * written with) is made executable again, and one that still cannot run stops the push before it starts (slice 7b
 * review RG-1).
 */
function ensureReceiveGuard(stateDirectory: string): string {
  const directory = join(stateDirectory, RECEIVE_HOOKS_DIRECTORY)
  const hook = join(directory, 'pre-receive')
  const content = `#!/bin/sh\nexec ${shellQuoted(process.execPath)} -e ${shellQuoted(GUARD_SOURCE)}\n`
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (readOrNull(hook) !== content) {
      const written = `${hook}.${process.pid}.${Date.now()}`
      writeFileSync(written, content, { mode: 0o700 })
      renameSync(written, hook)
    }
  } catch {
    throw new ToolExecutionError(`Buckle could not write its receive-pack guard at ${hook}; a push to a repository on this filesystem is not run without it`, { code: 'GIT_ISOLATION_UNAVAILABLE' })
  }
  if (!executable(hook)) {
    try {
      setMode(hook, 0o700)
    } catch {
      // Judged by the test below.
    }
    if (!executable(hook)) throw new ToolExecutionError(`Buckle's receive-pack guard at ${hook} cannot be run (its execute permission cannot be set, or the state directory is on a noexec mount), and git would skip it; a push to a repository on this filesystem is not run without it`, { code: 'GIT_ISOLATION_UNAVAILABLE' })
  }
  return directory
}

/** Whether this process may execute the file at `path`, as git tests a hook before it runs one. */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * One local push's guard: what it is told, through the environment git hands the receiving git and its hooks, with a
 * nonce made for this push alone, and how its refusal is read back out of the failed push's stderr: only a line that
 * carries that nonce is Buckle's (slice 7c review RGC-1).
 */
export function receiveGuard(input: { repository: string; gitDirectory: string; remedy: string }): { environment: Record<string, string>; refusedBy: (stderr: string) => string | null } {
  const nonce = randomBytes(16).toString('hex')
  return {
    environment: { BUCKLE_RECEIVE_REPOSITORY: input.repository, BUCKLE_RECEIVE_GIT_DIRECTORY: input.gitDirectory, BUCKLE_RECEIVE_REMEDY: input.remedy, BUCKLE_RECEIVE_NONCE: nonce },
    refusedBy: stderr => guardRefusal(stderr, nonce),
  }
}

/** The guard's reason when a failed push's stderr carries its refusal with this push's nonce, or null for any other failure. */
function guardRefusal(stderr: string, nonce: string): string | null {
  const start = `${BEFORE_NONCE}${nonce}${AFTER_NONCE}`
  const at = stderr.indexOf(start)
  if (at < 0) return null
  const end = stderr.indexOf('\n', at)
  return stderr.slice(at + start.length, end < 0 ? stderr.length : end).trim()
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function shellQuoted(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}
