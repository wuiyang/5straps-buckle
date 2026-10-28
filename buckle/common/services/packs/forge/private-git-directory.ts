import { randomUUID } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'pathe'
import { isPlainName } from '../../../domain/paths.js'
import { ToolInputError } from '../../../domain/tool.js'
import { MAX_ENTRIES, ownGitDirectory } from './own-git-directory.js'
import { includesAnotherFile } from './remote.js'

/** Where the copies live, under Buckle's state directory. */
const COPIES_DIRECTORY = 'git-push'
/** What a push reads from the git directory beside its objects, each copied where present. */
const COPIED_ENTRIES = ['HEAD', 'config', 'config.worktree', 'packed-refs', 'shallow', 'refs', 'reftable']
const PUSH_FROM_CLONE = 'push from a clone in the workspace'

export interface PrivateGitDirectory {
  /** GIT_DIR, GIT_WORK_TREE, and GIT_OBJECT_DIRECTORY for the one git call that runs on the copy. */
  environment: Record<string, string>
  remove: () => void
}

/**
 * A copy of the git directory of a repository in a mount the owner shares read-only, owner-only under Buckle's state
 * directory, for git_push to run on, so whatever git writes beside a push lands in the copy (fix brief 6, item 5): git
 * 2.56 moves the remote-tracking ref of the one remote whose push URL is the destination, and writes its reflog. HEAD,
 * the config, and the refs are copied; the objects are read in place through GIT_OBJECT_DIRECTORY, which also reads
 * that store's own `objects/info/alternates`. The git directory must be the repository's own `.git` folder, with no
 * pointer and no link in it (ownGitDirectory), so it is its common directory too and nothing else holds its refs. A
 * copy holds regular files and folders alone. Refused, naming the repository by `shown`, where any of that fails.
 */
export function privateGitDirectory(input: { repository: string; stateDirectory: string; shown: string }): PrivateGitDirectory {
  const gitDirectory = ownGitDirectoryOrRefuse(input)
  const copy = copyGitDirectory({ gitDirectory, stateDirectory: input.stateDirectory, shown: input.shown })
  return { environment: { GIT_DIR: copy.path, GIT_WORK_TREE: input.repository, GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects') }, remove: copy.remove }
}

/** ownGitDirectory's own refusal names host paths, which a mount hides, so it is replaced by one naming the mount. */
function ownGitDirectoryOrRefuse(input: { repository: string; shown: string }): string {
  try {
    return ownGitDirectory({ repository: input.repository, remedy: PUSH_FROM_CLONE })
  } catch {
    throw new ToolInputError(`The repository at ${input.shown} is in a mount the owner shares read-only, and its .git is not a folder of its own with no link in it, so Buckle cannot push from a private copy of it and refuses rather than let git write there; ${PUSH_FROM_CLONE}`, { code: 'PERMISSION_DENIED' })
  }
}

/**
 * The copy itself, removed again where it cannot be made whole. The repository's config may include no other file
 * (readRepositoryConfig), and neither may its `config.worktree` here: git reads a relative include, and tests an
 * `includeIf "gitdir:"`, from where the copy is, so the push would read config the checks before it never saw.
 */
function copyGitDirectory(input: { gitDirectory: string; stateDirectory: string; shown: string }): { path: string; remove: () => void } {
  const refusal = (problem: string) => new ToolInputError(`The repository at ${input.shown} is in a mount the owner shares read-only, and ${problem}, so git is not run; ${PUSH_FROM_CLONE}`, { code: 'PERMISSION_DENIED' })
  const notCopied = 'Buckle could not copy its git directory to push from without writing there'
  const parent = join(input.stateDirectory, COPIES_DIRECTORY)
  const path = join(parent, randomUUID())
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    mkdirSync(path, { mode: 0o700 })
  } catch {
    throw refusal(notCopied)
  }
  const remove = () => rmSync(path, { recursive: true, force: true })
  try {
    const budget = { remaining: MAX_ENTRIES }
    for (const name of COPIED_ENTRIES) copyEntry({ from: join(input.gitDirectory, name), to: join(path, name), budget })
    const worktreeConfig = join(path, 'config.worktree')
    if (lstatSync(worktreeConfig, { throwIfNoEntry: false }) && includesAnotherFile(readFileSync(worktreeConfig, 'utf8'))) {
      throw refusal('its config.worktree includes another file, which git would look for beside the private copy Buckle pushes from rather than beside the repository')
    }
  } catch (error) {
    remove()
    throw error instanceof ToolInputError ? error : refusal(notCopied)
  }
  return { path, remove }
}

/** A regular file or a folder copied whole, an absent one skipped; a link, a pipe, a device, or an odd name throws. */
function copyEntry(input: { from: string; to: string; budget: { remaining: number } }): void {
  const stats = lstatSync(input.from, { throwIfNoEntry: false })
  if (!stats) return
  if (--input.budget.remaining < 0) throw new Error('too many entries to copy')
  if (stats.isFile()) return copyFileSync(input.from, input.to)
  if (!stats.isDirectory()) throw new Error('neither a file nor a folder')
  mkdirSync(input.to, { mode: 0o700 })
  for (const name of readdirSync(input.from)) {
    // A name pathe would read as another path (a backslash on Linux) would be copied as one, so it is refused.
    if (!isPlainName(name)) throw new Error('not a plain name')
    copyEntry({ from: join(input.from, name), to: join(input.to, name), budget: input.budget })
  }
}
