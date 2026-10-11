import { realpathSync, statSync } from 'node:fs'
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
  const spawnGit = (input: { cwd: string; args: string[]; config: GitConfig[]; boundary: string; timeoutMs: number; signal: AbortSignal }): Promise<ProcessResult> => {
    if (options.git.path === null) throw new ToolExecutionError(options.git.reason, { code: 'GIT_FAILED' })
    return options.runProcess({
      command: options.git.path,
      argv0: options.git.argv0,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      environment: environment({ ...ISOLATION_ENVIRONMENT, ...ceilingEnvironment(input.boundary), ...gitConfigEnvironment(input.config) }),
      signal: input.signal,
    })
  }

  /** `args` may be built from the judged real repository git runs in, for a path git is handed relative to it. */
  const run = async (input: Pick<ToolContext, 'timeoutMs' | 'signal' | 'authorizeReadTarget'> & {
    repo: string
    args: string[] | ((repository: string) => string[])
  }): Promise<string> => {
    const cwd = resolveRepository({ paths: options.paths, repo: input.repo, context: input })
    const boundary = repositoryBoundary(options.paths, cwd, platform)
    const isolation = isolationConfig(ensureHooksDirectory(options.stateDirectory))
    const spawnHere = (args: string[], config: GitConfig[]) => spawnGit({ cwd, args, config, boundary, timeoutMs: input.timeoutMs, signal: input.signal })
    assertRepositoryInside({ answer: await spawnHere(REPOSITORY_QUERY, isolation), boundary, repo: input.repo, platform })
    const keys = await configuredFilterPrograms({
      spawn: args => spawnHere(args, isolation),
      describeFailure: result => describeProcessFailure('git config --list', result),
    })
    const config = [...isolation, ...filterProgramOverrides(keys)]
    const args = typeof input.args === 'function' ? input.args(cwd) : input.args
    const result = await spawnHere(args, config)
    if (result.exitCode !== 0) {
      throw new ToolExecutionError(describeProcessFailure('git', result), { code: 'GIT_FAILED' })
    }
    return result.stdout
  }

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
        return parseStatus(await run({ repo: input.repo, args, ...context }))
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_diff',
      description: 'Unified diff of the working tree or the staged index.',
      risk: 'read',
      tags: ['git'],
      input: diffInput,
      effects: input => [{ kind: 'read_path', path: input.repo }],
      run: async (input, context): Promise<JsonValue> => {
        const args = ['diff', `--unified=${input.contextLines}`, '--no-color', ...PATCH_SAFETY_ARGS]
        if (input.staged) args.push('--staged')
        if (input.paths.length > 0) args.push('--', ...input.paths)
        return { diff: await run({ repo: input.repo, args, ...context }) }
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_log',
      description: 'Recent commits as structured records.',
      risk: 'read',
      tags: ['git'],
      input: logInput,
      effects: input => [{ kind: 'read_path', path: input.repo }],
      run: async (input, context): Promise<JsonValue> => {
        const format = ['%H', '%an', '%aI', '%s'].join('%x1f')
        const args = ['log', `--max-count=${input.limit}`, `--format=${format}`]
        if (input.path) args.push('--', input.path)
        return { commits: parseLog(await run({ repo: input.repo, args, ...context })) }
      },
    }),
    defineTool(PACK_ID, {
      name: 'git_blame',
      description: 'Line-by-line authorship for a file.',
      risk: 'read',
      tags: ['git'],
      input: blameInput,
      // The repository is read too, and the file is where git finds it: under the repository (review L5 of the second re-review).
      effects: input => [{ kind: 'read_path', path: input.repo }, { kind: 'read_path', path: blamedFile(input) }],
      run: async (input, context): Promise<JsonValue> => {
        // git is handed the judged real file, named from the judged real repository it runs in, never the agent's string.
        const file = judgedPath({ named: blamedFile(input), kind: 'read', paths: options.paths, context })
        const args = ['blame', '--line-porcelain', '--no-textconv']
        if (input.startLine) args.push('-L', `${input.startLine},${input.endLine ?? input.startLine}`)
        return { lines: parseBlame(await run({ repo: input.repo, args: repository => [...args, '--', relative(repository, file)], ...context })) }
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

/** The file git_blame reads, as its effect names it: where git finds it, under the repository. */
function blamedFile(input: { repo: string; path: string }): string {
  return isAbsolute(input.path) ? input.path : join(input.repo, withForwardSlashes(input.path))
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
 * The real root git must find its whole repository in: the workspace root or the scratch root that holds the judged
 * directory, as each really is, or, for a directory outside them all that a read approval judged, that directory.
 */
function repositoryBoundary(paths: PathView, judged: string, platform: NodeJS.Platform): string {
  return [paths.root, ...paths.scratchRoots].map(root => realPathOr(root, platform)).find(root => isInside(root, judged, platform)) ?? judged
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
function assertRepositoryInside(input: { answer: ProcessResult; boundary: string; repo: string; platform: NodeJS.Platform }): void {
  if (input.answer.exitCode !== 0) throw new ToolExecutionError(`git finds no repository with a work tree at ${input.repo} inside the root it lies in`, { code: 'GIT_NO_REPOSITORY' })
  const places = input.answer.stdout.split('\n').filter(Boolean).map(place => realPlace(place, input.platform))
  if (places.length === 3 && places.every(place => place !== null && isInside(input.boundary, place, input.platform))) return
  throw new ToolInputError(`The repository git finds at ${input.repo} keeps its files or history outside the root it lies in, where no permission check looked, so git is not run there`, { code: 'PERMISSION_DENIED' })
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
