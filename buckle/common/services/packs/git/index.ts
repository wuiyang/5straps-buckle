import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'pathe'
import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { hostEnvironment, type HostEnvironment } from '../../../domain/environment.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError, type ToolContext } from '../../../domain/tool.js'
import type { ProcessResult, ProcessRunner } from '../../../types/ports/process-runner.js'
import { configuredFilterPrograms, ensureHooksDirectory, filterProgramOverrides, gitConfigEnvironment, isolationConfig, ISOLATION_ENVIRONMENT, type GitConfig } from '../git-isolation.js'
import { judgedPath } from '../judged-path.js'
import { loadPackSkill } from '../pack-skill.js'
import { describeProcessFailure } from '../process-failure.js'
import { isInside, nativePath, parentDirectory, withForwardSlashes } from '../../../domain/paths.js'
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
/** The variables git finds a repository, its objects, its index, or its config by: always the pack's own, never its caller's. */
const GIT_VARIABLE = /^GIT_/i

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
  }): Promise<string> => {
    const cwd = resolveRepository({ paths: options.paths, repo: input.repo, context: input })
    const args = typeof input.args === 'function' ? input.args(cwd) : input.args
    const boundary = repositoryBoundary(options.paths, cwd, platform)
    const isolation = isolationConfig(ensureHooksDirectory(options.stateDirectory))
    const spawnHere = (args: string[], config: GitConfig[], extra?: Record<string, string>) => spawnGit({ cwd, args, config, boundary, timeoutMs: input.timeoutMs, signal: input.signal, ...(extra ? { extra } : {}) })
    const found = await spawnHere(REPOSITORY_QUERY, isolation)
    const repository = assertRepositoryInside({ answer: found, boundary, repo: input.repo, platform })
    const pinned = pinRepository(repository, platform)
    const spawnPinned = (args: string[], config: GitConfig[], extra?: Record<string, string>) => {
      pinned.assertUnchanged()
      return spawnHere(args, config, { ...pinned.environment, ...extra })
    }
    const keys = await configuredFilterPrograms({
      spawn: args => spawnPinned(args, isolation),
      describeFailure: result => describeProcessFailure('git config --list', result),
    })
    const config = [...isolation, ...filterProgramOverrides(keys)]
    const readOnly = input.refreshesIndex === true && options.paths.mountOf(cwd)?.access === 'ro'
    const index = readOnly ? privateIndex({ repository, stateDirectory: options.stateDirectory, shown: options.paths.display(cwd) }) : null
    try {
      const result = await spawnPinned(args, index ? [...config, ...PRIVATE_INDEX_CONFIG] : config, index?.environment)
      // A swap while git ran is refused too, before git's own answer, which may name where it was pointed.
      pinned.assertUnchanged()
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
        const args = ['status', '--porcelain=v2', '--branch']
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
        const args = ['diff', `--unified=${input.contextLines}`, '--no-color', ...PATCH_SAFETY_ARGS]
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
        const args = ['blame', '--line-porcelain', '--no-textconv']
        if (input.startLine) args.push('-L', `${input.startLine},${input.endLine ?? input.startLine}`)
        const file = named(input.repo, input.path)
        return { lines: parseBlame(await run({ repo: input.repo, args: repository => [...args, ...pathspec(repository, [file], context)], ...context })) }
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
  const places = input.answer.stdout.split('\n').filter(Boolean).map(place => realPlace(place, input.platform))
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
  const identities = () => places.map(place => directoryIdentity(place, platform))
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

/** A directory's device and inode, where `place` is one and is still its own real path; null otherwise. */
function directoryIdentity(place: string, platform: NodeJS.Platform): string | null {
  const stats = lstatSync(place, { bigint: true, throwIfNoEntry: false })
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
