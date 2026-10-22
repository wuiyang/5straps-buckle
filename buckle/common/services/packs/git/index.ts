import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { posix } from 'node:path'
import { isAbsolute, join, normalize, relative } from 'pathe'
import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { hostEnvironment, type HostEnvironment } from '../../../domain/environment.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError, type ToolContext } from '../../../domain/tool.js'
import type { ProcessResult, ProcessRunner } from '../../../types/ports/process-runner.js'
import { configuredKeyNames, ensureHooksDirectory, filterProgramOverrides, gitConfigEnvironment, isolationConfig, ISOLATION_ENVIRONMENT, type GitConfig } from '../git-isolation.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { judgedPath } from '../judged-path.js'
import { loadPackSkill } from '../pack-skill.js'
import { describeProcessFailure } from '../process-failure.js'
import { isInside, isInsideAny, nativePath, parentDirectory, withForwardSlashes } from '../../../domain/paths.js'
import { ownRoots, realPathOr, type ResolvedProgram } from '../../../domain/executable.js'

const PACK_ID = 'git'
/** Unit separator: safe inside commit subjects and branch names, unlike any printable delimiter. */
const FIELD_SEPARATOR = '\x1f'
/**
 * `diff.<driver>.command` and `diff.<driver>.textconv` name programs git runs for a path whose
 * attributes ask for that driver, and an empty `diff.external` stops neither. Only the command
 * line does.
 */
const PATCH_SAFETY_ARGS = ['--no-ext-diff', '--no-textconv']
/** What git is asked before it runs: the work tree, the git directory, and the common one of the repository it finds. */
const REPOSITORY_QUERY = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']
/**
 * Every path git is handed is a file or folder by that name, never a pattern or a `:(magic)` pathspec: the path judged
 * is the path read (D77). `.en*` would otherwise print `.env`'s diff while only a file named `.en*` was judged.
 */
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' }
/** Constant, so a refusal shows no path the agent did not write (D9, D17). */
const OUTSIDE_REPOSITORY = 'Refused: a path outside the repository, which the git tools never read; nothing was run'
/** Constant too: a repository moved mid-call, whose new place is no business of the agent's. */
const REPOSITORY_MOVED = 'The repository changed while Buckle checked it, so nothing git read from it is shown; send the call again'
/** Constant as well: where a repository borrows objects from is the owner's business, never shown to the agent. */
const BORROWS_OUTSIDE = 'The repository borrows objects from outside the workspace, so git is not run there'
/** Constant again: a store reached through a place that names another in git's process, or that Buckle cannot walk as git does. */
const UNRESOLVED_STORE = 'The repository borrows objects through a place Buckle cannot resolve as git does, so git is not run there'
/** The most links one store's place may pass through, as Linux allows (SYMLOOP_MAX). */
const STORE_LINKS = 40
/** How many levels of an object store's own alternates git follows (it ignores those nested deeper), and one more. */
const ALTERNATES_DEPTH = 6
/** The most of one alternates file read; a longer one is refused rather than read in part. */
const ALTERNATES_BYTES = 64 * 1024
/**
 * What one check spends at most, each refused past rather than spent: the object stores it reads, the alternates lines
 * it resolves, the names it walks over all of their places, and the units those names cost. The check runs on the node's
 * single thread three times a call, so stores each naming every other held it for seconds (git pack recheck 3,
 * held[1]); git itself follows a handful of stores. A name costs the depth of the path so far, since lstat walks every
 * component of it and the system's real path is quadratic in depth: one call with a path 1,800 folders deep held the
 * thread for 12 to 25 s with every count far under its cap (git pack recheck 4, held[0]). Walking a name at depth d
 * costs d + 1 units, so a path of 100 names costs about 5,000 and one of 724 names uses the whole budget.
 */
const ALTERNATES_STORES = 32
const ALTERNATES_LINES = 256
const ALTERNATES_NAMES = 8192
const ALTERNATES_UNITS = 262_144
/** Constant as well: how much a repository borrows is the owner's business. */
const TOO_MANY_STORES = 'The repository borrows objects from more stores, or through longer paths, than Buckle checks, so git is not run there'
/** The variables git finds a repository, its objects, its index, or its config by: always the pack's own, never its caller's. */
const GIT_VARIABLE = /^GIT_/i
/**
 * A submodule's repository is reached through the `.git` pointer in its work-tree folder, which no check here reads and
 * which may lead outside the workspace, so no call shows a submodule's changes or history (git pack recheck 1,
 * held[1]). The command line is the guard, since it outranks every config the repository or `.gitmodules` sets: status
 * and diff take this flag. The keys below are a second layer, read after the repository's own config. git_log prints no
 * patch and git_blame reads no gitlink, so neither takes the flag. Whatever the flag says, git still opens the
 * submodule's HEAD, config, and refs to compare the recorded commit, so a call still runs where that folder cannot be
 * read, and an error in those files can name it (git pack recheck 2, held[1]; known-limits-02). Refusing a gitlink
 * whose pointer leads outside the roots is a follow-up.
 */
const IGNORE_SUBMODULES = '--ignore-submodules=all'
/**
 * `blame.ignoreRevsFile` names a file git blame reads as object ids and dies quoting the first line that is none, so a
 * repository's config could have the first line of any file the node's user can read in the error the agent gets, with
 * no read of that file judged (git pack recheck 4, held[1]). No config value empties the list, since git keeps it sorted,
 * so the command line is the guard: `--no-ignore-revs-file` clears it. A config that names the key refuses the call too,
 * with a constant reason, as only git_blame reads the file. The empty value is set on the command alone, never in the
 * scope the config listing runs under, which would then name the key in every repository.
 */
const BLAME_IGNORE_REVS_KEY = 'blame.ignorerevsfile'
const BLAME_NAMES_A_FILE = 'The repository config names a file for git blame to read, which Buckle does not judge, so git_blame is not run there'
const BLAME_CONFIG: GitConfig[] = [{ key: 'blame.ignoreRevsFile', value: '' }]
const SUBMODULE_CONFIG: GitConfig[] = [
  { key: 'diff.ignoreSubmodules', value: 'all' },
  { key: 'diff.submodule', value: 'short' },
  { key: 'status.submoduleSummary', value: 'false' },
  { key: 'submodule.recurse', value: 'false' },
]

const repoInput = z.object({ repo: z.string().default('.') })
const statusInput = repoInput.extend({ untracked: z.boolean().default(true) })
const diffInput = repoInput.extend({
  staged: z.boolean().default(false),
  paths: z.array(z.string()).max(100).default([]),
  contextLines: z.number().int().min(0).max(20).default(3),
})
const logInput = repoInput.extend({
  limit: z.number().int().min(1).max(500).default(20),
  path: z.string().optional(),
})
const blameInput = repoInput.extend({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
})

export interface GitPackOptions {
  paths: PathView
  runProcess: ProcessRunner
  /** Buckle's own state directory, which is where the empty hooks directory git is pointed at lives. */
  stateDirectory: string
  /** The git this node runs, by its real path (resolveProgram), or why none is run. */
  git: ResolvedProgram
  /** The environment git runs with (hostEnvironment); the workspace's own roots alone when absent. */
  environment?: HostEnvironment
  /** The host's unless a test imitates another. */
  platform?: NodeJS.Platform
}

export function createGitPack(options: GitPackOptions): Pack {
  const environment = options.environment ?? hostEnvironment(() => ownRoots(options.paths))
  const platform = options.platform ?? process.platform
  const spawnGit = (input: { cwd: string; args: string[]; config: GitConfig[]; boundary: string; timeoutMs: number; signal: AbortSignal; extra?: Record<string, string> }): Promise<ProcessResult> => {
    if (options.git.path === null) throw new ToolExecutionError(options.git.reason, { code: 'GIT_FAILED' })
    return options.runProcess({
      command: options.git.path,
      argv0: options.git.argv0,
      args: [...options.git.args, ...input.args],
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      environment: withOwnGitVariables(environment, { ...ISOLATION_ENVIRONMENT, ...LITERAL_PATHSPECS, ...ceilingEnvironment(input.boundary), ...gitConfigEnvironment(input.config), ...input.extra }),
      signal: input.signal,
    })
  }

  /**
   * `args` may be built from the judged real repository git runs in, for a path git is handed relative to it; they are
   * built before anything is spawned, so a path refused there runs nothing.
   * `refreshesIndex`: the command may write the repository's index (git diff refreshes it whatever GIT_OPTIONAL_LOCKS
   * says), so in a mount the owner shares read-only it runs on a private copy of the index instead.
   *
   * Only the repository query finds the repository; every later spawn runs against the places it resolved (D77, the
   * rev-parse race), checked unchanged before each and after the command (pinRepository).
   */
  const run = async (input: Pick<ToolContext, 'timeoutMs' | 'signal' | 'authorizeReadTarget'> & {
    repo: string
    args: string[] | ((repository: string) => string[])
    refreshesIndex?: boolean
    /** A config key, lowercase, that refuses this command where the repository lists it, and the constant reason (no path, no value). */
    refusesKey?: { key: string; reason: string }
    /** Config for the command alone: the listing runs under the isolation without it. */
    commandConfig?: GitConfig[]
  }): Promise<string> => {
    const cwd = resolveRepository({ paths: options.paths, repo: input.repo, context: input })
    const args = typeof input.args === 'function' ? input.args(cwd) : input.args
    const boundary = repositoryBoundary(options.paths, cwd, platform)
    const isolation = [...isolationConfig(ensureHooksDirectory(options.stateDirectory)), ...SUBMODULE_CONFIG]
    const spawnHere = (args: string[], config: GitConfig[], extra?: Record<string, string>) => spawnGit({ cwd, args, config, boundary, timeoutMs: input.timeoutMs, signal: input.signal, ...(extra ? { extra } : {}) })
    const found = await spawnHere(REPOSITORY_QUERY, isolation)
    const repository = assertRepositoryInside({ answer: found, boundary, repo: input.repo, platform })
    const pinned = pinRepository(repository, platform)
    // The objects git may read, its own and every store it borrows from, are checked wherever the places are (D77).
    const assertUnchanged = () => {
      pinned.assertUnchanged()
      assertObjectsInside(repository, boundary, options.paths, platform)
    }
    const spawnPinned = (args: string[], config: GitConfig[], extra?: Record<string, string>) => {
      assertUnchanged()
      return spawnHere(args, config, { ...pinned.environment, ...extra })
    }
    const keys = await configuredKeyNames({
      spawn: args => spawnPinned(args, isolation),
      describeFailure: result => describeProcessFailure('git config --list', result),
    })
    if (input.refusesKey && keys.some(key => key.toLowerCase() === input.refusesKey!.key)) throw new ToolInputError(input.refusesKey.reason, { code: 'PERMISSION_DENIED' })
    const config = [...isolation, ...filterProgramOverrides(keys), ...(input.commandConfig ?? [])]
    const readOnly = input.refreshesIndex === true && options.paths.mountOf(cwd)?.access === 'ro'
    const index = readOnly ? privateIndex({ repository, stateDirectory: options.stateDirectory, shown: options.paths.display(cwd) }) : null
    try {
      const result = await spawnPinned(args, index ? [...config, ...PRIVATE_INDEX_CONFIG] : config, index?.environment)
      // A swap while git ran is refused too, before git's own answer, which may name where it was pointed.
      assertUnchanged()
      if (result.exitCode !== 0) {
        throw new ToolExecutionError(describeProcessFailure('git', result), { code: 'GIT_FAILED' })
      }
      return result.stdout
    } finally { index?.remove() }
  }

  /** A path a tool names, as its effect declares it: joined to the repository, and refused when it leaves it. */
  const named = (repo: string, path: string) => repositoryPath(options.paths, repo, path, platform)
  /**
   * `--` and each named path as git is handed it: the judged real path relative to the judged real repository, never
   * the agent's string, refused before any spawn where it lands outside the repository (a link out of it).
   */
  const pathspec = (repository: string, paths: string[], context: Pick<ToolContext, 'authorizeReadTarget'>): string[] => paths.length === 0 ? [] : ['--', ...paths.map(path => {
    const real = judgedPath({ named: path, kind: 'read', paths: options.paths, context })
    if (!isInside(repository, real, platform)) throw new ToolInputError(OUTSIDE_REPOSITORY, { code: 'PERMISSION_DENIED' })
    return relative(repository, real) || '.'
  })]

  const tools = [
    defineTool(PACK_ID, {
      name: 'git_status',
      description: 'Working tree status as structured entries, plus the current branch.',
      risk: 'read',
      tags: ['git'],
      input: statusInput,
      effects: input => [{ kind: 'read_path', path: input.repo }],
      run: async (input, context): Promise<JsonValue> => {
        const args = ['status', '--porcelain=v2', '--branch', IGNORE_SUBMODULES]
        if (!input.untracked) args.push('--untracked-files=no')
        return parseStatus(await run({ repo: input.repo, args, refreshesIndex: true, ...context }))
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_diff',
      description: 'Unified diff of the working tree or the staged index.',
      risk: 'read',
      tags: ['git'],
      input: diffInput,
      // Each path named is read too (D77); a diff of the whole tree names none, and shows every tracked file (known limit).
      effects: input => [{ kind: 'read_path', path: input.repo }, ...input.paths.map(path => ({ kind: 'read_path' as const, path: named(input.repo, path) }))],
      run: async (input, context): Promise<JsonValue> => {
        const args = ['diff', `--unified=${input.contextLines}`, '--no-color', ...PATCH_SAFETY_ARGS, IGNORE_SUBMODULES]
        if (input.staged) args.push('--staged')
        const paths = input.paths.map(path => named(input.repo, path))
        return { diff: await run({ repo: input.repo, args: repository => [...args, ...pathspec(repository, paths, context)], refreshesIndex: true, ...context }) }
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_log',
      description: 'Recent commits as structured records.',
      risk: 'read',
      tags: ['git'],
      input: logInput,
      effects: input => [{ kind: 'read_path', path: input.repo }, ...(input.path === undefined ? [] : [{ kind: 'read_path' as const, path: named(input.repo, input.path) }])],
      run: async (input, context): Promise<JsonValue> => {
        const format = ['%H', '%an', '%aI', '%s'].join('%x1f')
        const args = ['log', `--max-count=${input.limit}`, `--format=${format}`]
        const paths = input.path === undefined ? [] : [named(input.repo, input.path)]
        return { commits: parseLog(await run({ repo: input.repo, args: repository => [...args, ...pathspec(repository, paths, context)], ...context })) }
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_blame',
      description: 'Line-by-line authorship for a file.',
      risk: 'read',
      tags: ['git'],
      input: blameInput,
      // The repository is read too, and the file is where git finds it: under the repository (review L5 of the second re-review).
      effects: input => [{ kind: 'read_path', path: input.repo }, { kind: 'read_path', path: named(input.repo, input.path) }],
      run: async (input, context): Promise<JsonValue> => {
        // git is handed the judged real file, named from the judged real repository it runs in, never the agent's string.
        const args = ['blame', '--line-porcelain', '--no-textconv', '--no-ignore-revs-file']
        if (input.startLine) args.push('-L', `${input.startLine},${input.endLine ?? input.startLine}`)
        const file = named(input.repo, input.path)
        const guard = { refusesKey: { key: BLAME_IGNORE_REVS_KEY, reason: BLAME_NAMES_A_FILE }, commandConfig: BLAME_CONFIG }
        return { lines: parseBlame(await run({ repo: input.repo, args: repository => [...args, ...pathspec(repository, [file], context)], ...guard, ...context })) }
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_branch',
      description: 'Local branches with their upstream and last commit.',
      risk: 'read',
      tags: ['git'],
      input: repoInput,
      effects: input => [{ kind: 'read_path', path: input.repo }],
      run: async (input, context): Promise<JsonValue> => {
        const format = ['%(refname:short)', '%(upstream:short)', '%(objectname:short)', '%(HEAD)'].join('%1f')
        const output = await run({ repo: input.repo, args: ['branch', '--list', `--format=${format}`], ...context })
        return { branches: parseBranches(output) }
      },
    }),
  ]

  return {
    id: PACK_ID,
    version: '1.0.0',
    tools,
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: options.git.path === null ? options.git.reason : null,
  }
}

/** A private index is written whole, with no untracked cache, so git writes nothing beside it in the repository. */
const PRIVATE_INDEX_CONFIG: GitConfig[] = [{ key: 'core.splitIndex', value: 'false' }, { key: 'core.untrackedCache', value: 'false' }]

/**
 * A copy of a repository's index under Buckle's state directory, owner-only, which git reads and may refresh in place
 * of the one in a mount the owner shares read-only (Q6): git writes `.git/index` and takes `.git/index.lock` when it
 * refreshes, and the read-only bind holds the shell alone. A repository with no index yet has none to copy, which
 * git reads as the empty index it is. Refused, plainly, where the copy cannot be made.
 *
 * A split index (core.splitIndex) names a `sharedindex.<sha>` file that git reads beside the git directory, not beside
 * the index it is handed, and sets the time of on every read (fix brief 6, item 6). There the copy is a private git
 * directory instead: HEAD, the index, and each shared index copied, and a `commondir` naming the repository's common
 * directory, whose refs, objects, and config git reads in place and status and diff write none of. git runs with it as
 * GIT_DIR and the work tree named, so nothing in the owner's `.git` is touched. What is copied is bounded by the index.
 */
function privateIndex(input: { repository: Repository; stateDirectory: string; shown: string }): { environment: Record<string, string>; remove: () => void } {
  const directory = join(input.stateDirectory, 'git-index')
  const { workTree, gitDirectory, commonDirectory } = input.repository
  const copy = join(directory, randomUUID())
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const shared = readdirSync(gitDirectory).filter(name => name.startsWith('sharedindex.'))
    if (shared.length === 0) {
      const path = `${copy}.index`
      const index = join(gitDirectory, 'index')
      if (existsSync(index)) copyFileSync(index, path)
      return { environment: { GIT_INDEX_FILE: path }, remove: () => { for (const file of [path, `${path}.lock`]) rmSync(file, { force: true }) } }
    }
    mkdirSync(copy, { mode: 0o700 })
    const remove = () => rmSync(copy, { recursive: true, force: true })
    try {
      for (const name of ['HEAD', 'index', ...shared]) if (existsSync(join(gitDirectory, name))) copyFileSync(join(gitDirectory, name), join(copy, name))
      writeFileSync(join(copy, 'commondir'), `${commonDirectory}\n`, { mode: 0o600 })
    } catch (error) { remove(); throw error }
    return { environment: { GIT_DIR: copy, GIT_WORK_TREE: workTree }, remove }
  } catch {
    throw new ToolInputError(`The repository at ${input.shown} is in a mount the owner shares read-only, and Buckle could not copy its index to read it without writing there, so git is not run`, { code: 'PERMISSION_DENIED' })
  }
}

/**
 * A path a git tool names, as its effect declares it: where git finds it, under the repository, an absolute one as it
 * is, with no trailing slash. Refused, with a constant reason, where the view reads it outside the repository the
 * agent named (a `..` or an absolute path elsewhere); a link out of it is refused where it is judged (pathspec).
 */
function repositoryPath(paths: PathView, repo: string, path: string, platform: NodeJS.Platform): string {
  // `secrets/` is the folder `secrets`, as the rules name it.
  const named = (isAbsolute(path) ? path : join(repo, withForwardSlashes(path))).replace(/(?<=.)\/+$/, '')
  const repository = paths.resolve(repo)
  let place: string
  try { place = paths.resolve(named) } catch { throw new ToolInputError(OUTSIDE_REPOSITORY, { code: 'PERMISSION_DENIED' }) }
  if (!isInside(repository, place, platform)) throw new ToolInputError(OUTSIDE_REPOSITORY, { code: 'PERMISSION_DENIED' })
  return named
}

/**
 * The judged real repository git runs in (judgedPath), never the name: a link swapped between the
 * check and the run is refused. A missing working directory makes `spawn` report `spawn git ENOENT`,
 * which reads as a missing git binary rather than a missing directory. Named here instead, before
 * anything is spawned.
 */
function resolveRepository(input: { paths: PathView; repo: string; context: Pick<ToolContext, 'authorizeReadTarget'> }): string {
  const cwd = judgedPath({ named: input.repo, kind: 'read', paths: input.paths, context: input.context })
  const stats = statSync(cwd, { throwIfNoEntry: false })
  if (!stats) throw new ToolExecutionError(`No such directory in this workspace: ${input.paths.display(cwd)}`, { code: 'GIT_NO_REPOSITORY' })
  if (!stats.isDirectory()) throw new ToolExecutionError(`Not a directory: ${input.paths.display(cwd)}`, { code: 'GIT_NO_REPOSITORY' })
  return cwd
}

/**
 * The real root git must find its whole repository in: the workspace root or the mount (a scratch root among them) that holds the judged
 * directory, as each really is, or, for a directory outside them all that a read approval judged, that directory.
 */
function repositoryBoundary(paths: PathView, judged: string, platform: NodeJS.Platform): string {
  return paths.reachableRoots.map(root => realPathOr(root, platform)).find(root => isInside(root, judged, platform)) ?? judged
}

/** Git looks for a repository no higher than `boundary`: GIT_CEILING_DIRECTORIES names the folder above it. */
function ceilingEnvironment(boundary: string): Record<string, string> {
  const parent = parentDirectory(boundary)
  return parent === boundary ? {} : { GIT_CEILING_DIRECTORIES: parent }
}

/**
 * Refused unless the repository git finds where it runs, asked under the isolation scope, keeps its work tree, its git
 * directory, and its common one inside `boundary`. Started in a folder that holds no repository of its own, git climbed
 * to one above the workspace, and a `.git` file, a `commondir`, or `core.worktree` points it at another: status, diff,
 * and log then showed files and commits no permission check judged, through a mount too. A bare repository has no work
 * tree to name, so it is refused with the rest.
 */
function assertRepositoryInside(input: { answer: ProcessResult; boundary: string; repo: string; platform: NodeJS.Platform }): Repository {
  if (input.answer.exitCode !== 0) throw new ToolExecutionError(`git finds no repository with a work tree at ${input.repo} inside the root it lies in`, { code: 'GIT_NO_REPOSITORY' })
  const answered = input.answer.stdout.split('\n').filter(Boolean)
  chargePlaces(answered)
  const places = answered.map(place => realPlace(place, input.platform))
  const [workTree, gitDirectory, commonDirectory] = places
  if (places.length === 3 && places.every(place => place !== null && isInside(input.boundary, place, input.platform))) return { workTree: workTree!, gitDirectory: gitDirectory!, commonDirectory: commonDirectory! }
  throw new ToolInputError(`The repository git finds at ${input.repo} keeps its files or history outside the root it lies in, where no permission check looked, so git is not run there`, { code: 'PERMISSION_DENIED' })
}

/** The places a repository query resolved, each by its real path, all checked inside the root the repository lies in. */
interface Repository { workTree: string; gitDirectory: string; commonDirectory: string }

/**
 * The repository a call's later spawns run against (D77, the rev-parse race): GIT_DIR, GIT_WORK_TREE, and GIT_COMMON_DIR
 * name the places the query resolved, so git finds nothing again by itself. A git directory named as a path git reads as
 * a `gitdir:` file once `.git` is one, so each is named with a trailing `/.`, which only a directory satisfies. The three
 * are taken as they are on disk once checked, each a directory its own real path reaches, by device and inode, and
 * `assertUnchanged` compares them again: before each spawn and after the command, so a `.git` swapped for a `gitdir:`
 * file or a link, or a folder above it for a link, is refused rather than followed. A swap made and undone while git
 * runs is not seen; the window is that run.
 */
function pinRepository(repository: Repository, platform: NodeJS.Platform): { environment: Record<string, string>; assertUnchanged: () => void } {
  const places = [repository.workTree, repository.gitDirectory, repository.commonDirectory]
  const identities = () => {
    chargePlaces(places)
    return places.map(place => directoryIdentity(place, platform))
  }
  const known = identities()
  const assertUnchanged = () => {
    const now = identities()
    if (known.some((identity, index) => identity === null || identity !== now[index])) throw new ToolInputError(REPOSITORY_MOVED, { code: 'PERMISSION_DENIED' })
  }
  assertUnchanged()
  return {
    environment: { GIT_DIR: `${repository.gitDirectory}/.`, GIT_WORK_TREE: repository.workTree, GIT_COMMON_DIR: `${repository.commonDirectory}/.` },
    assertUnchanged,
  }
}

/**
 * Refused, naming no path, where git would read objects from outside every root the view reaches and outside
 * `boundary`, the folder the repository query was checked against, which for a repository outside them all that a read
 * approval judged is that folder (repositoryBoundary; D77, objects/info/alternates): the objects folder of the git
 * directory and of the common one, which may be a link, each object store their `info/alternates` names, and in turn
 * each of those stores' own, as deep as git follows them. A
 * line is a path, absolute or, as git reads it, relative to the real objects folder holding the file; one starting
 * with `"` is C-quoted and is refused where its quoting is not whole; a blank line and a `#` line name none. Each is
 * the bytes git opens (storePlaces), resolved by its real path as git resolves it, so a `..` climbs from where a link
 * points (landingOf). A line passes only where both readings land inside, the bytes git opens and the line folded as
 * text, as a git that folds a line reads it: folded first, a `..` after a link landed inside while git read a store
 * outside (git pack recheck 2, held[2]). Where git cannot normalize the bytes it opens it reads no store there, and the
 * fold must still land inside. An absent file is the normal case. git reads GIT_ALTERNATE_OBJECT_DIRECTORIES too, which
 * it never has here (withOwnGitVariables).
 */
function assertObjectsInside(repository: Repository, boundary: string, paths: PathView, platform: NodeJS.Platform): void {
  const budget = checkBudget()
  const reach = { roots: [...paths.reachableRoots.map(root => realPathOr(root, platform)), boundary], shares: paths.shares, platform, spendName: budget.name }
  const inside = (landing: Landing): Buffer => {
    if (landing === NO_STORE) throw new ToolInputError(UNRESOLVED_STORE, { code: 'PERMISSION_DENIED' })
    if (landing === null) throw new ToolInputError(BORROWS_OUTSIDE, { code: 'PERMISSION_DENIED' })
    return landing
  }
  const named = (store: Buffer, line: Buffer): Buffer[] => {
    const { opened, folded } = storePlaces(store, line, platform)
    const opening = landingOf(opened, reach)
    return [...(opening === NO_STORE ? [] : [inside(opening)]), inside(landingOf(folded, reach))]
  }
  const read = new Set<string>()
  let stores = [...new Set([repository.gitDirectory, repository.commonDirectory])].map(directory => inside(landingOf(Buffer.from(join(directory, 'objects')), reach)))
  for (let depth = 0; depth < ALTERNATES_DEPTH && stores.length > 0; depth++) {
    stores = stores.flatMap(store => {
      const key = store.toString('latin1')
      if (read.has(key)) return []
      read.add(key)
      budget.store()
      const lines = alternatesOf(store)
      budget.lines(lines.length)
      return lines.flatMap(line => named(store, line))
    })
  }
}

/**
 * One check's spending: each store read, each line counted before any is resolved, each name walked, and the units
 * each costs, its depth plus one. A repository's own places are charged what walking them would cost (chargePlaces).
 */
function checkBudget(): { store: () => void; lines: (count: number) => void; name: (depth: number) => void; place: (place: string) => void } {
  const spent = { stores: 0, lines: 0, names: 0, units: 0 }
  const spend = (kind: keyof typeof spent, count: number, cap: number) => {
    spent[kind] += count
    if (spent[kind] > cap) throw new ToolInputError(TOO_MANY_STORES, { code: 'PERMISSION_DENIED' })
  }
  return {
    store: () => spend('stores', 1, ALTERNATES_STORES),
    lines: count => spend('lines', count, ALTERNATES_LINES),
    name: depth => { spend('names', 1, ALTERNATES_NAMES); spend('units', depth + 1, ALTERNATES_UNITS) },
    place: place => {
      const names = place.split('/').filter(Boolean).length
      spend('units', (names * (names + 1)) / 2, ALTERNATES_UNITS)
    },
  }
}

/**
 * Refused, before the system is asked for the real path of any, where the places of a repository are together so deep
 * that resolving them is costly: each is charged what walking it name by name would cost, as one check's budget.
 * The query, and each pin that compares the places again, resolve them with realpath(3), which is quadratic in depth.
 */
function chargePlaces(places: readonly string[]): void {
  const budget = checkBudget()
  for (const place of places) budget.place(place)
}

/** Where a store lands: its real path inside the roots; null outside them; NO_STORE where git reads no store there. */
type Landing = Buffer | null | typeof NO_STORE
const NO_STORE = Symbol('no store')

/**
 * Where a store lands, by its real path, when that lies inside one of `roots`; null otherwise. Off Windows the place is
 * walked as git walks it (walkAsGit), as bytes, which git opens as they are, and compared with each root's own bytes,
 * then checked against the system's own answer (walkedAsTheSystem). On Windows git reads a line as UTF-8, so one that is
 * not is refused, and the text is resolved as every other path is, a store not made yet where it would be made.
 */
function landingOf(place: Buffer, input: { roots: string[]; shares: readonly string[]; platform: NodeJS.Platform; spendName: (depth: number) => void }): Landing {
  if (input.platform === 'win32') return windowsLanding(place, input)
  const walked = walkAsGit(place, input.spendName)
  if (walked.kind === 'no-store') return NO_STORE
  if (!input.roots.some(root => insideBytes(Buffer.from(root), walked.real))) return null
  if (!walkedAsTheSystem(place, walked)) throw new ToolInputError(UNRESOLVED_STORE, { code: 'PERMISSION_DENIED' })
  return walked.real
}

function windowsLanding(place: Buffer, input: { roots: string[]; shares: readonly string[]; platform: NodeJS.Platform }): Buffer | null {
  const text = utf8Of(place)
  if (text === null) return null
  try {
    const real = resolveTarget(text, { shares: input.shares, platform: input.platform })
    return isInsideAny(input.roots, real, input.platform) ? Buffer.from(real) : null
  } catch { return null }
}

/** A place as git resolved it: an existing one, one whose last name is absent (a store made while git runs), or none. */
type Walked = { kind: 'found'; real: Buffer } | { kind: 'absent'; real: Buffer; parent: Buffer } | { kind: 'no-store' }

/**
 * `place`, an absolute path, walked as git's strbuf_realpath walks it, in this process and never by changing its working
 * directory: name by name from the root, a link replaced by its target, a `..` dropping the last name reached, so it
 * climbs from where a link points, even out of a file. Only a last name may be absent; where an earlier one is, git
 * reads no store there. Refused, with a constant reason, where the walk reaches a place that names another in git's
 * process, `/proc` (its `self`, `thread-self`, and their `cwd` and `fd`) or `/dev/fd`, or follows a link whose target
 * starts with `/proc/` or `/dev/`: git changes into the work tree first, so `/proc/self/cwd` was the node's working
 * directory here and the work tree there (git pack recheck 3, held[0]). Refused too past STORE_LINKS links, and where
 * any name cannot be read for another reason than being absent. Each name taken is spent (`spendName`), at the depth
 * reached, so a deep path is refused after a few hundred names rather than walked whole.
 */
function walkAsGit(place: Buffer, spendName: (depth: number) => void): Walked {
  const unresolved = () => new ToolInputError(UNRESOLVED_STORE, { code: 'PERMISSION_DENIED' })
  const resolved: Buffer[] = []
  const pending = namesOf(place).reverse()
  let links = 0
  while (pending.length > 0) {
    const name = pending.pop()!
    spendName(resolved.length)
    if (name.length === 0 || name.equals(DOT)) continue
    if (name.equals(DOT_DOT)) { resolved.pop(); continue }
    resolved.push(name)
    if (namesPerProcess(resolved)) throw unresolved()
    const path = pathOf(resolved)
    let isLink: boolean
    try { isLink = lstatSync(path).isSymbolicLink() } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw unresolved()
      return pending.length === 0 ? { kind: 'absent', real: path, parent: pathOf(resolved.slice(0, -1)) } : { kind: 'no-store' }
    }
    if (!isLink) continue
    if (++links > STORE_LINKS) throw unresolved()
    let target: Buffer
    try { target = readlinkSync(path, { encoding: 'buffer' }) } catch { throw unresolved() }
    if (PER_PROCESS_TARGETS.some(prefix => target.subarray(0, prefix.length).equals(prefix))) throw unresolved()
    resolved.pop()
    if (target[0] === SLASH) resolved.length = 0
    for (const next of namesOf(target).reverse()) pending.push(next)
  }
  return { kind: 'found', real: pathOf(resolved) }
}

const DOT = Buffer.from('.')
const DOT_DOT = Buffer.from('..')
const PER_PROCESS_TARGETS = [Buffer.from('/proc/'), Buffer.from('/dev/')]

/** Whether the names walked so far lie in `/proc` or `/dev/fd`, which name the reading process's own places. */
function namesPerProcess(resolved: readonly Buffer[]): boolean {
  const [first, second] = resolved
  return first?.equals(PROC) === true || (first?.equals(DEV) === true && second?.equals(FD) === true)
}

const PROC = Buffer.from('proc')
const DEV = Buffer.from('dev')
const FD = Buffer.from('fd')

/** The names of a path split on `/`, as bytes, empty ones kept: one after the last name means more follows it. */
function namesOf(path: Buffer): Buffer[] {
  const names: Buffer[] = []
  let start = 0
  for (let end = path.indexOf(SLASH); end !== -1; end = path.indexOf(SLASH, start)) {
    names.push(path.subarray(start, end))
    start = end + 1
  }
  names.push(path.subarray(start))
  return names
}

/** The absolute path of `names`, from the root, copied once: the walk builds one for every name it takes. */
function pathOf(names: readonly Buffer[]): Buffer {
  if (names.length === 0) return SEPARATOR
  let length = names.length
  for (const name of names) length += name.length
  const path = Buffer.allocUnsafe(length)
  let at = 0
  for (const name of names) {
    path[at++] = SLASH
    at += name.copy(path, at)
  }
  return path
}

const SEPARATOR = Buffer.from('/')

/**
 * Whether the system's own real path (realpath(3)) of `place` is the walk's, so a place the walk read otherwise than the
 * system follows it is refused: for a place whose last name is absent, the system finds it absent and its folder where
 * the walk did.
 */
function walkedAsTheSystem(place: Buffer, walked: Exclude<Walked, { kind: 'no-store' }>): boolean {
  if (walked.kind === 'found') return sameReal(place, walked.real)
  return systemReal(place) === 'absent' && sameReal(walked.parent, walked.parent)
}

function sameReal(place: Buffer, real: Buffer): boolean {
  const answer = systemReal(place)
  return Buffer.isBuffer(answer) && answer.equals(real)
}

function systemReal(place: Buffer): Buffer | 'absent' | 'unreadable' {
  try { return realpathSync.native(place, { encoding: 'buffer' }) } catch (error) { return codeOf(error) === 'ENOENT' ? 'absent' : 'unreadable' }
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** Whether the real path `real` is the real directory `root` or lies beneath it, compared byte for byte. */
function insideBytes(root: Buffer, real: Buffer): boolean {
  if (real.equals(root)) return true
  return real.length > root.length && real.subarray(0, root.length).equals(root) && (root.at(-1) === SLASH || real[root.length] === SLASH)
}

const SLASH = 0x2f

/** `bytes` as UTF-8 text, the same bytes again when encoded; null where they are not UTF-8. */
function utf8Of(bytes: Buffer): string | null {
  try { return UTF8.decode(bytes) } catch { return null }
}

/** Fatal, so bytes that are not UTF-8 are never read as other text; a byte order mark is kept, as it is part of the name. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The store a line names, two ways. `opened` is the bytes git opens: an absolute line as written, a relative one after
 * the real objects folder holding the file and a `/`, never folded, so its real path climbs each `..` from where a link
 * points, as git resolves it. `folded` is the same folded as text, as a git that folds a line reads it. Off Windows the
 * bytes are kept one for one (folded as latin1, where each byte is one character), and a backslash, which is part of a
 * name there, or a leading drive letter refuses the line, as before. On Windows the line is UTF-8 (refused where it is
 * not), its backslashes are separators, and it is folded as any other Windows path.
 */
function storePlaces(store: Buffer, line: Buffer, platform: NodeJS.Platform): { opened: Buffer; folded: Buffer } {
  const refused = () => new ToolInputError(BORROWS_OUTSIDE, { code: 'PERMISSION_DENIED' })
  if (platform === 'win32') {
    const text = utf8Of(line)
    if (text === null) throw refused()
    let named: string
    try { named = withForwardSlashes(text, platform) } catch { throw refused() }
    const base = store.toString('utf8')
    return isAbsolute(named)
      ? { opened: Buffer.from(named), folded: Buffer.from(normalize(named)) }
      : { opened: Buffer.from(`${base}/${named}`), folded: Buffer.from(join(base, named)) }
  }
  const named = line.toString('latin1')
  try { withForwardSlashes(named, platform) } catch { throw refused() }
  const absolute = named.startsWith('/')
  return {
    opened: absolute ? line : Buffer.concat([store, Buffer.from('/'), line]),
    folded: Buffer.from(absolute ? posix.normalize(named) : posix.join(store.toString('latin1'), named), 'latin1'),
  }
}

/**
 * The stores one object store's `info/alternates` names, each line as git reads it, as bytes; none where it has no such
 * file. The file is read whole up to ALTERNATES_BYTES and refused past it, and refused where it is no regular file (a
 * device or a pipe, which git would read without end); a folder of that name is none, as git reads none.
 */
function alternatesOf(store: Buffer): Buffer[] {
  const refused = () => new ToolInputError(BORROWS_OUTSIDE, { code: 'PERMISSION_DENIED' })
  const file = Buffer.concat([store, Buffer.from('/info/alternates')])
  let bytes: Buffer
  try {
    const stats = statSync(file)
    if (stats.isDirectory()) return []
    if (!stats.isFile() || stats.size > ALTERNATES_BYTES) throw refused()
    bytes = readFileSync(file)
  } catch (error) {
    if (error instanceof ToolInputError) throw error
    // git reads no alternates where the file cannot be read, absent or not.
    return []
  }
  if (bytes.length > ALTERNATES_BYTES) throw refused()
  return linesOf(bytes).filter(line => line.length > 0 && line[0] !== HASH).map(line => {
    const path = line[0] === QUOTE ? unquoted(line) : line
    if (path === null) throw refused()
    return path
  })
}

const HASH = 0x23
const QUOTE = 0x22
const BACKSLASH = 0x5c

/** The lines of a file git splits on a newline byte, each as bytes. */
function linesOf(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
    lines.push(bytes.subarray(start, end))
    start = end + 1
  }
  lines.push(bytes.subarray(start))
  return lines
}

const C_ESCAPES: Readonly<Record<string, number>> = { a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '"': QUOTE, '\\': BACKSLASH }

/**
 * A line git reads as C-quoted, unquoted as git unquotes it (unquote_c_style), each `\ooo` escape and each C escape one
 * byte; null where its quoting is not whole up to the line's end, which git would read otherwise.
 */
function unquoted(line: Buffer): Buffer | null {
  const bytes: number[] = []
  for (let index = 1; index < line.length; index++) {
    const byte = line[index]!
    if (byte === QUOTE) return index === line.length - 1 ? Buffer.from(bytes) : null
    if (byte !== BACKSLASH) { bytes.push(byte); continue }
    const digits = line.toString('latin1', index + 1, index + 4)
    if (/^[0-3][0-7]{2}$/.test(digits)) { bytes.push(Number.parseInt(digits, 8)); index += 3; continue }
    const escape = String.fromCharCode(line[index + 1] ?? 0)
    if (!Object.hasOwn(C_ESCAPES, escape)) return null
    bytes.push(C_ESCAPES[escape]!)
    index++
  }
  return null
}

/**
 * A directory's device and inode, where `place` is one and is still its own real path; null otherwise, and where it
 * cannot be read: lstat throws ENOTDIR, whatever throwIfNoEntry says, once a folder above the place has become a file.
 */
function directoryIdentity(place: string, platform: NodeJS.Platform): string | null {
  let stats
  try { stats = lstatSync(place, { bigint: true, throwIfNoEntry: false }) } catch { return null }
  if (!stats?.isDirectory() || realPlace(place, platform) !== place) return null
  return `${stats.dev}:${stats.ino}`
}

/**
 * git's environment: the caller's, with every `GIT_` variable it carries dropped, and the pack's own set over it. A
 * caller's GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_SYSTEM, or the like would point git
 * at a repository, objects, or config no check looked at (D77).
 */
function withOwnGitVariables(environment: HostEnvironment, own: Record<string, string>): NodeJS.ProcessEnv {
  const merged = environment(own)
  for (const name of Object.keys(merged)) if (GIT_VARIABLE.test(name) && !Object.hasOwn(own, name)) delete merged[name]
  return merged
}

/** Where a place git named really is, in pathe's form, or null when it cannot be found. */
function realPlace(place: string, platform: NodeJS.Platform): string | null {
  try { return nativePath(realpathSync.native(place), platform) } catch { return null }
}

function parseStatus(output: string): JsonValue {
  const entries: JsonValue[] = []
  let branch: string | null = null
  let upstream: string | null = null

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length)
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const fields = line.split(' ')
      entries.push({ state: fields[1] ?? '', path: fields.slice(8).join(' ') })
    } else if (line.startsWith('? ')) entries.push({ state: 'untracked', path: line.slice(2) })
  }

  return { branch, upstream, entries, clean: entries.length === 0 }
}

function parseLog(output: string): JsonValue[] {
  return output.split('\n').filter(Boolean).map(line => {
    const [hash = '', author = '', date = '', subject = ''] = line.split(FIELD_SEPARATOR)
    return { hash, author, date, subject }
  })
}

function parseBlame(output: string): JsonValue[] {
  const lines: JsonValue[] = []
  let current: { hash: string; author: string } | null = null

  for (const line of output.split('\n')) {
    const header = line.match(/^([0-9a-f]{40})\s+\d+\s+\d+/)
    if (header) current = { hash: header[1] ?? '', author: '' }
    else if (line.startsWith('author ') && current) current.author = line.slice('author '.length)
    else if (line.startsWith('\t') && current) {
      lines.push({ hash: current.hash, author: current.author, text: line.slice(1) })
      current = null
    }
  }
  return lines
}

function parseBranches(output: string): JsonValue[] {
  return output.split('\n').filter(Boolean).map(line => {
    const [name = '', upstream = '', commit = '', head = ''] = line.split(FIELD_SEPARATOR)
    return { name, upstream: upstream || null, commit, current: head.trim() === '*' }
  })
}
