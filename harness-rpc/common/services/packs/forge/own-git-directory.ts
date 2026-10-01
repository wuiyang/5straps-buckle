import { lstatSync, readdirSync, realpathSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'
import { ToolInputError } from '../../../domain/tool.js'

/** A linked worktree's pointers, which send git's objects and refs to another repository. */
export const POINTER_FILES = ['commondir', 'gitdir']
/** Where a push or commit writes refs and their logs; a link anywhere below sends one elsewhere. */
export const REF_DIRECTORIES = ['refs', 'logs']
/** Entries read in the git directory before the repository is refused as too large to check. */
export const MAX_ENTRIES = 65_536

/**
 * The git directory a push to, or a commit in, `repository` writes, read from the disk before any git runs
 * there (review H1 of the continuation review). The permission rules judge the repository's own path, and git
 * follows a `.git` file (`gitdir:`), a `.git` link, a `commondir` file or a linked `objects`, `refs` or `HEAD`
 * into a repository nothing judged, so each is refused: the git directory is `<repository>/.git` as a real
 * directory, or the repository itself when it is bare, with no pointer file and no link in it. `remedy` says
 * what the caller can do instead. A local push repeats it in the receiving git, before any ref is written
 * (receive-pack-guard.ts).
 */
export function ownGitDirectory(input: { repository: string; remedy: string }): string {
  const refuse = (problem: string): never => {
    throw new ToolInputError(`${problem}, so git would write somewhere the permission rules never judged; ${input.remedy}`, { code: 'PERMISSION_DENIED' })
  }
  if (!statOf(input.repository)?.isDirectory()) refuse(`${input.repository} is not a directory`)
  const dotGit = join(input.repository, '.git')
  const pointer = statOf(dotGit)
  if (pointer?.isSymbolicLink()) refuse(`${dotGit} is a symbolic link`)
  if (pointer && !pointer.isDirectory()) refuse(`${dotGit} is a file pointing git at another repository`)
  const gitDirectory = pointer ? dotGit : input.repository
  for (const name of POINTER_FILES) {
    if (statOf(join(gitDirectory, name))) refuse(`${join(gitDirectory, name)} points git at another repository`)
  }
  const budget: Budget = { remaining: MAX_ENTRIES, exceeded: () => refuse(`${gitDirectory} holds more than ${MAX_ENTRIES} entries to check`) }
  const scans = [
    { directory: gitDirectory, depth: 1 },
    { directory: join(gitDirectory, 'objects'), depth: 1 },
    ...REF_DIRECTORIES.map(name => ({ directory: join(gitDirectory, name), depth: Infinity })),
  ]
  for (const scan of scans) {
    const linked = firstLink({ ...scan, budget })
    if (linked !== null) refuse(`${linked} is a symbolic link`)
  }
  return gitDirectory
}

/**
 * Checked once git can be asked, under the same isolation as every other call: git itself must resolve the
 * repository to the git directory read from the disk, as both its git directory and its common one. A
 * directory git does not read as a repository at all (receive-pack would then try `<repository>.git` beside it,
 * and a commit would climb to a parent) is refused the same way.
 */
export function assertGitAgrees(input: { repository: string; gitDirectory: string; answer: { exitCode: number | null; stdout: string }; remedy: string }): void {
  const resolved = input.answer.exitCode === 0 ? input.answer.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
  if (resolved.length === 2 && resolved.every(path => realPathOf(path) === input.gitDirectory)) return
  throw new ToolInputError(`git does not resolve ${input.repository} to its own git directory ${input.gitDirectory}, so it would write somewhere the permission rules never judged; ${input.remedy}`, { code: 'PERMISSION_DENIED' })
}

/** What `git rev-parse` is asked for `assertGitAgrees`. */
export const GIT_DIRECTORY_QUERY = ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir']

interface Budget { remaining: number; exceeded: () => never }

/** The first symbolic link in `directory` or below it, to `depth` levels; a directory that is absent holds none. */
function firstLink(input: { directory: string; depth: number; budget: Budget }): string | null {
  let entries: Dirent[]
  try {
    entries = readdirSync(input.directory, { withFileTypes: true })
  } catch {
    return null
  }
  input.budget.remaining -= entries.length
  if (input.budget.remaining < 0) input.budget.exceeded()
  for (const entry of entries) {
    const path = join(input.directory, entry.name)
    if (entry.isSymbolicLink()) return path
    if (!entry.isDirectory() || input.depth <= 1) continue
    const found = firstLink({ directory: path, depth: input.depth - 1, budget: input.budget })
    if (found !== null) return found
  }
  return null
}

function statOf(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}
