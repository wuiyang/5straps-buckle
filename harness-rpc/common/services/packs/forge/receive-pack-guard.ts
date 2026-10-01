import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolExecutionError } from '../../../domain/tool.js'
import { MAX_ENTRIES, POINTER_FILES, REF_DIRECTORIES } from './own-git-directory.js'

/** Buckle-owned, and where the receiving git of a local push finds its hooks: the guard below, and nothing else. */
const RECEIVE_HOOKS_DIRECTORY = 'receive-git-hooks'
/** What the guard writes before its reason, so its refusal is told apart from any other failed push. */
const REFUSAL = 'Buckle refused the push in the receiving git: '

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
const { BUCKLE_RECEIVE_REPOSITORY: repository, BUCKLE_RECEIVE_GIT_DIRECTORY: gitDirectory, BUCKLE_RECEIVE_REMEDY: remedy, GIT_QUARANTINE_PATH: quarantine } = process.env
const refuse = (problem) => {
  process.stderr.write(${JSON.stringify(REFUSAL)} + problem + ', so git would write somewhere the permission rules never judged; ' + (remedy || 'push to the real repository by its own path') + NEWLINE)
  process.exit(1)
}
const statOf = (path) => { try { return lstatSync(path) } catch { return null } }
const realPathOf = (path) => { try { return realpathSync.native(path) } catch { return null } }
if (!repository || !gitDirectory) refuse('the push named no checked destination')
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
 * The hooks directory the receiving git of a local push is pointed at (receivingIsolationConfig's
 * `core.hooksPath`), holding only the guard as `pre-receive`, run by this process's own node. Written in
 * Buckle's state directory and replaced whole, so a push never runs a half-written hook.
 */
export function ensureReceiveGuard(stateDirectory: string): string {
  const directory = join(stateDirectory, RECEIVE_HOOKS_DIRECTORY)
  const hook = join(directory, 'pre-receive')
  const content = `#!/bin/sh\nexec ${shellQuoted(process.execPath)} -e ${shellQuoted(GUARD_SOURCE)}\n`
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (readOrNull(hook) === content) return directory
    const written = `${hook}.${process.pid}.${Date.now()}`
    writeFileSync(written, content, { mode: 0o700 })
    renameSync(written, hook)
  } catch {
    throw new ToolExecutionError(`Buckle could not write its receive-pack guard at ${hook}; a push to a repository on this filesystem is not run without it`, { code: 'GIT_ISOLATION_UNAVAILABLE' })
  }
  return directory
}

/** What the guard is told about the push, through the environment git hands the receiving git and its hooks. */
export function receiveGuardEnvironment(input: { repository: string; gitDirectory: string; remedy: string }): Record<string, string> {
  return { BUCKLE_RECEIVE_REPOSITORY: input.repository, BUCKLE_RECEIVE_GIT_DIRECTORY: input.gitDirectory, BUCKLE_RECEIVE_REMEDY: input.remedy }
}

/** The guard's reason when a failed push's stderr carries one, or null for any other failure. */
export function guardRefusal(stderr: string): string | null {
  const at = stderr.indexOf(REFUSAL)
  if (at < 0) return null
  const end = stderr.indexOf('\n', at)
  return stderr.slice(at + REFUSAL.length, end < 0 ? stderr.length : end).trim()
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
