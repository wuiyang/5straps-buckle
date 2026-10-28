import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'pathe'
import { z } from 'zod'
import { redactCredentials } from '@5straps/runtime'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { hostEnvironment, type HostEnvironment } from '../../../domain/environment.js'
import type { ToolEffect } from '../../../domain/effect.js'
import { ownRoots, type ResolvedProgram } from '../../../domain/executable.js'
import type { ForgeClient, ForgeRepository } from '../../../domain/forge.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { isInside } from '../../../domain/paths.js'
import { stripSecret } from '../../../domain/redact.js'
import { defineTool, ToolExecutionError, ToolInputError, type ToolContext } from '../../../domain/tool.js'
import { effectivePort, type UrlMatcher } from '../../../domain/url-pattern.js'
import type { ProcessResult, ProcessRunner } from '../../../types/ports/process-runner.js'
import { judgedPath } from '../judged-path.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { loadPackSkill } from '../pack-skill.js'
import { describeProcessFailure } from '../process-failure.js'
import { configuredFilterPrograms, configuredKeyNames, ensureHooksDirectory, filterProgramKeys, gitConfigEnvironment, isolationConfig, ISOLATION_ENVIRONMENT, mergeDriverKeys, transportConfig, type GitConfig } from '../git-isolation.js'
import { assertNoFilters, assertNoFilterPrograms, assertNoMergeDrivers } from './isolation.js'
import { assertGitAgrees, GIT_DIRECTORY_QUERY, ownGitDirectory } from './own-git-directory.js'
import { privateGitDirectory } from './private-git-directory.js'
import { guardedReceivePackCommand, receiveGuard } from './receive-pack-guard.js'
import { classifyRemote, readOriginUrl, remoteSubject, repositoryOf, type ForgeRemote } from './remote.js'

const PACK_ID = 'forge'
const MAX_DIFF_BYTES = 524_288
/** Unit separator: safe inside a commit subject, unlike any printable delimiter. */
const FIELD_SEPARATOR = '\x1f'
/** No leading dash, so a branch can never be read as a flag, and no `..` or ref-name punctuation. */
const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/
/** A commit as git_revert takes it: an object name or a revision (`HEAD~2`, `main^`, `v1.0`), never a flag. */
const REVISION_PATTERN = /^[A-Za-z0-9._@][A-Za-z0-9._/~^@{}-]*$/
/** Said where a revert stopped on a conflict: git's own `git revert --abort` put back what the revert wrote, and only that. */
const REVERT_ABORTED = 'the revert stopped on a conflict and was aborted, so the repository stands as it was'
/** What a person's own unfinished revert, cherry-pick, or merge leaves in the git directory (review B1 of the Slice D rules review). */
const UNFINISHED_OPERATION_MARKERS = ['REVERT_HEAD', 'CHERRY_PICK_HEAD', 'MERGE_HEAD', 'sequencer']
/** What a refusal of a redirected repository tells the caller to do instead (review H1 of the continuation review). */
const PUSH_REMEDY = 'push to the real repository by its own path (set origin to it) so the permission rules judge it'
const COMMIT_REMEDY = 'commit in the real repository by its own path so the permission rules judge it'

const repoInput = z.object({ repo: z.string().default('.') })

const commitInput = repoInput.extend({
  message: z.string().min(1).max(20_000),
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(500),
})

const pushInput = repoInput.extend({
  branch: z.string().min(1).max(255),
  setUpstream: z.boolean().default(false),
  force: z.boolean().default(false),
})

const openInput = repoInput.extend({
  head: z.string().min(1).max(255),
  base: z.string().min(1).max(255),
  title: z.string().min(1).max(500),
  body: z.string().max(60_000).default(''),
})

const revertInput = repoInput.extend({
  commit: z.string().min(1).max(255),
  /** For a merge commit: the parent, from 1, whose side the revert keeps. */
  mainline: z.number().int().min(1).max(64).optional(),
})

const readInput = repoInput.extend({
  number: z.number().int().min(1),
  include: z.array(z.enum(['diff', 'comments', 'files'])).max(3).default([]),
})

export interface ForgePackOptions {
  paths: PathView
  runProcess: ProcessRunner
  /** The git this node runs, by its real path (resolveProgram), or why none is run. */
  git: ResolvedProgram
  /** The environment git runs with (hostEnvironment); the workspace's own roots alone when absent. */
  environment?: HostEnvironment
  /** Buckle's own state directory, which is where the empty hooks directory git is pointed at lives. */
  stateDirectory: string
  forge: {
    /** Null when the node holds no credential; the pack is withheld and the tools never run. */
    client: ForgeClient | null
    /** The API origin every pull-request call declares as its network effect. */
    apiUrl: string
    /** The only host the credential is ever sent to. */
    gitHost: string
    token: string
  }
  /** The identity every commit carries, so a node's commits are attributable without a global config. */
  author: { name: string; email: string }
  /** The owner's approved list, so a remote off the forge host is pushed to only where it says so. */
  approved: UrlMatcher | null
  unavailableReason: string | null
}

/** The git that receives a push: its command, its environment, and for Buckle's own guard, how to read its refusal. */
interface ReceivingGit {
  command: string
  environment: Record<string, string>
  refusedBy?: (stderr: string) => string | null
}

export function createForgePack(options: ForgePackOptions): Pack {
  const { forge, paths } = options
  const environment = options.environment ?? hostEnvironment(() => ownRoots(paths))

  const runGit = async (input: { repository: string; args: string[]; config?: GitConfig[]; extra?: Record<string, string>; context: ToolContext }): Promise<ProcessResult> => {
    const config = [...isolationConfig(ensureHooksDirectory(options.stateDirectory)), ...(input.config ?? [])]
    if (options.git.path === null) throw new ToolExecutionError(options.git.reason, { code: 'GIT_FAILED' })
    return await options.runProcess({
      command: options.git.path,
      argv0: options.git.argv0,
      args: [...options.git.args, ...input.args],
      cwd: input.repository,
      timeoutMs: input.context.timeoutMs,
      environment: environment({ ...ISOLATION_ENVIRONMENT, ...gitConfigEnvironment(config), ...input.extra }),
      signal: input.context.signal,
    })
  }

  /** Strips the forge credential in both its forms, and any other secret the call carries (a push's userinfo). */
  const scrub = (text: string, secrets: readonly string[] = []): string => [...credentialForms(forge.token), ...secrets].reduce(stripSecret, text)

  /** A forge answer is text someone else wrote, so every string in it is scrubbed, not only git's. */
  const scrubJson = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return scrub(value)
    if (Array.isArray(value)) return value.map(scrubJson)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubJson(entry)]))
    return value
  }

  /** `refusedBy` reads a permission refusal out of a failed call's stderr, which is then raised as one. */
  const gitOutput = async (input: { repository: string; args: string[]; config?: GitConfig[]; extra?: Record<string, string>; secrets?: readonly string[]; refusedBy?: (stderr: string) => string | null; context: ToolContext }): Promise<string> => {
    const result = await runGit(input)
    const refused = result.exitCode === 0 ? null : input.refusedBy?.(result.stderr) ?? null
    if (refused !== null) throw new ToolInputError(scrub(refused, input.secrets), { code: 'PERMISSION_DENIED' })
    if (result.exitCode !== 0) throw new ToolExecutionError(scrub(describeProcessFailure('git', result), input.secrets), { code: 'GIT_FAILED' })
    return scrub(result.stdout, input.secrets)
  }

  /** Which filter programs git resolves here, asked of git so no config scope is missed. */
  const filterPrograms = (input: { repository: string; context: ToolContext }): Promise<string[]> => {
    return configuredFilterPrograms({
      spawn: args => runGit({ repository: input.repository, args, context: input.context }),
      describeFailure: result => scrub(describeProcessFailure('git config --list', result)),
    })
  }

  /** Absent config is exit 1, which is an answer rather than a failure. */
  const configValues = async (input: { repository: string; key: string; context: ToolContext }): Promise<string[]> => {
    const result = await runGit({ repository: input.repository, args: ['config', '--get-all', input.key], context: input.context })
    if (result.exitCode === 1) return []
    if (result.exitCode !== 0) throw new ToolExecutionError(scrub(describeProcessFailure('git', result)), { code: 'GIT_FAILED' })
    return nonEmptyLines(scrub(result.stdout))
  }

  /**
   * Every entry of every config scope git reads here that matches `pattern`, asked of git under the same
   * isolation as the push (so an include and the worktree config count, and the hidden global and system
   * scopes do not): `key` alone with `nameOnly`. Exit 1 is git saying nothing matches.
   */
  const configEntries = async (input: { repository: string; pattern: string; nameOnly?: boolean; context: ToolContext }): Promise<Array<{ key: string; value: string }>> => {
    const result = await runGit({ repository: input.repository, args: ['config', '--null', ...(input.nameOnly ? ['--name-only'] : []), '--get-regexp', input.pattern], context: input.context })
    if (result.exitCode === 1) return []
    if (result.exitCode !== 0) throw new ToolExecutionError(scrub(describeProcessFailure('git config', result)), { code: 'GIT_FAILED' })
    if (result.truncated) throw new ToolExecutionError('This repository has more git config than Buckle reads in one pass, so git_push cannot prove where git would send the push; it is refused', { code: 'GIT_ISOLATION_UNAVAILABLE' })
    return result.stdout.split('\0').filter(Boolean).map((entry) => {
      const newline = entry.indexOf('\n')
      return newline === -1 ? { key: entry, value: '' } : { key: entry.slice(0, newline), value: entry.slice(newline + 1) }
    })
  }

  /**
   * Checked at launch, under the write lock, against the exact destination git is handed (review H3). Git
   * reads a push argument as a remote name before it reads it as a URL or a path, and applies every
   * url.<base>.insteadOf and pushInsteadOf whose value begins it (an empty value begins every one). So no
   * remote may be named by the destination or shaped like a URL, and no rewrite rule may match the destination.
   * Git applies a remote only when its name is the argument itself, so a remote named anything else, such as
   * `team/fork`, redirects nothing and is left alone (review L8 of the slice 5 re-review).
   */
  const assertDestinationUnaliased = async (input: { repository: string; destination: ForgeRemote; context: ToolContext }): Promise<void> => {
    const target = pushTarget(input.destination)
    const spellings = destinationSpellings({ destination: input.destination, typed: classifyRemote(readOriginUrl(input.repository)) })
    const names = (await configEntries({ ...input, pattern: '^remote\\.', nameOnly: true })).map(entry => remoteNameOf(entry.key))
    const named = names.find(name => name.includes(':') || spellings.has(sameRepositoryName(name)))
    if (named !== undefined) {
      throw new ToolInputError(`this repository names a remote ${JSON.stringify(redactCredentials(named, 'value'))}, which is shaped like a URL or names the push destination; git reads a push destination as a remote name first, so the push to ${input.destination.display} is refused rather than sent where that remote points. Rename or remove that remote`, { code: 'PERMISSION_DENIED' })
    }
    const rules = await configEntries({ ...input, pattern: '^url\\..*\\.(insteadof|pushinsteadof)$' })
    if (rules.some(rule => target.startsWith(rule.value))) {
      throw new ToolInputError(`an insteadOf or pushInsteadOf rule rewrites ${input.destination.display} before the push; the push is refused rather than sent to a target the permission rules never saw`, { code: 'PERMISSION_DENIED' })
    }
  }

  /** What the config names, before any rewrite rule reaches it. `pushurl` replaces `url` for a push. */
  const readConfiguredPushUrl = async (input: { repository: string; context: ToolContext }): Promise<PushUrl> => {
    const pushUrls = await configValues({ ...input, key: 'remote.origin.pushurl' })
    if (pushUrls.length > 1) {
      throw new ToolInputError(`origin has ${pushUrls.length} remote.origin.pushurl values and git pushes to every one of them; the forge tools push to a single judged target`, { code: 'PERMISSION_DENIED' })
    }
    const urls = pushUrls.length ? pushUrls : await configValues({ ...input, key: 'remote.origin.url' })
    if (urls.length !== 1) {
      throw new ToolInputError(`origin names ${urls.length} URLs, and the forge tools push to a single judged target`, { code: 'PERMISSION_DENIED' })
    }
    const raw = urls[0] ?? ''
    return { raw, remote: classifyRemote(raw) }
  }

  /** What git would really push to: every push URL, rewrite rules already applied. */
  const readResolvedPushUrl = async (input: { repository: string; context: ToolContext }): Promise<PushUrl> => {
    const urls = nonEmptyLines(await gitOutput({ ...input, args: ['remote', 'get-url', '--push', '--all', 'origin'] }))
    if (urls.length !== 1) {
      throw new ToolInputError(`origin resolves to ${urls.length} push URLs and git pushes to every one of them; the forge tools push to a single judged target`, { code: 'PERMISSION_DENIED' })
    }
    const raw = urls[0] ?? ''
    return { raw, remote: classifyRemote(raw) }
  }

  /**
   * Checked at launch: the remote git itself would push to now (which settles any pushurl or rewrite rule
   * the config carries) must be the destination the permission rules judged before the approval, not
   * merely the one the config names now (GPT review of c71dee5, git destination binding).
   */
  const assertPushTarget = async (input: { repository: string; pinned: ForgeRemote; context: ToolContext }): Promise<void> => {
    const declared = judgedRemote(classifyRemote(readOriginUrl(input.repository)))
    const configured = await readConfiguredPushUrl(input)
    const actual = await readResolvedPushUrl(input)
    assertNoRewrite({ configured, actual })
    for (const now of [declared, judgedRemote(actual.remote)]) {
      if (destinationOf(now) !== destinationOf(input.pinned)) {
        throw new ToolInputError(`origin resolves to ${now.display}, not the ${input.pinned.display} the permission rules judged; the push is refused rather than sent somewhere unjudged`, { code: 'PERMISSION_DENIED' })
      }
    }
  }

  /**
   * Review H1 of the continuation review: the repository a local push or a commit writes is the one the rules
   * judged, its git directory read from the disk first (no git runs where a pointer sends it) and then as git
   * itself resolves it.
   */
  const assertGitResolvesOwn = async (input: { repository: string; gitDirectory: string; remedy: string; context: ToolContext }): Promise<void> => {
    const answer = await runGit({ repository: input.repository, args: GIT_DIRECTORY_QUERY, context: input.context })
    assertGitAgrees({ ...input, answer })
  }

  /**
   * How a push reaches `repository` on this filesystem, once its git directory is its own (review H1 of the
   * continuation review): the receiving git's command, pointed at Buckle's guard as its only hook, and what the
   * guard is told so it can test the repository git really opened before any ref is written (slice 7 review F3).
   * Only this receiving git is Buckle's, so only its refusal is read as one (slice 7b review RG-2), and only a line with
   * this push's nonce, which the destination's own text cannot carry (slice 7c review RGC-1).
   */
  const guardedReceivePack = async (input: { repository: string; context: ToolContext }): Promise<ReceivingGit> => {
    const gitDirectory = ownGitDirectory({ repository: input.repository, remedy: PUSH_REMEDY })
    await assertGitResolvesOwn({ repository: input.repository, gitDirectory, remedy: PUSH_REMEDY, context: input.context })
    return { command: guardedReceivePackCommand(options.stateDirectory), ...receiveGuard({ repository: input.repository, gitDirectory, remedy: PUSH_REMEDY }) }
  }

  const forgeRepository = (repository: string): ForgeRepository => {
    const remote = classifyRemote(readOriginUrl(repository))
    assertForgeHost({ remote, forge })
    return repositoryOf(remote)
  }

  /** The identity every commit a forge tool makes carries, author and committer both. */
  const identity = {
    GIT_AUTHOR_NAME: options.author.name,
    GIT_AUTHOR_EMAIL: options.author.email,
    GIT_COMMITTER_NAME: options.author.name,
    GIT_COMMITTER_EMAIL: options.author.email,
  }

  /**
   * The commit git_revert undoes, by its full object name, and its parents, refused where the name is no commit here, or
   * is a merge commit and the call names no mainline.
   */
  const commitToRevert = async (input: { repository: string; commit: string; mainline: number | undefined; context: ToolContext }): Promise<{ hash: string; parents: string[] }> => {
    const found = await runGit({ repository: input.repository, args: ['rev-parse', '--verify', '--quiet', `${input.commit}^{commit}`], context: input.context })
    if (found.exitCode !== 0) throw new ToolInputError(`${input.commit} names no commit in this repository`)
    const hash = scrub(found.stdout).trim()
    const [, ...parents] = (await gitOutput({ repository: input.repository, args: ['rev-list', '--parents', '--max-count=1', hash], context: input.context })).trim().split(' ').filter(Boolean)
    if (parents.length > 1 && input.mainline === undefined) throw new ToolInputError(`${input.commit} is a merge commit; name mainline, the parent whose side the revert keeps (1 for the branch it was merged into)`)
    return { hash, parents }
  }

  /** The paths a revert of `hash` touches, against the parent it keeps (the first, unless mainline names another), or all of a root commit's. */
  const revertedPaths = async (input: { repository: string; hash: string; parents: string[]; mainline: number | undefined; context: ToolContext }): Promise<string[]> => {
    const parent = input.parents[(input.mainline ?? 1) - 1]
    const args = parent === undefined ? ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '-z', input.hash] : ['diff-tree', '-r', '--name-only', '-z', parent, input.hash]
    return (await gitOutput({ repository: input.repository, args, context: input.context })).split('\0').filter(Boolean)
  }

  /**
   * Refused before git_revert runs: a revert, cherry-pick, or merge already stopped here is a person's, and the abort
   * this tool runs after a conflict of its own (`reset --merge`) would discard their staged or unmerged resolution.
   */
  const assertNoUnfinishedOperation = async (input: { repository: string; context: ToolContext }): Promise<void> => {
    for (const marker of UNFINISHED_OPERATION_MARKERS) {
      const located = (await gitOutput({ repository: input.repository, args: ['rev-parse', '--git-path', marker], context: input.context })).trim()
      if (existsSync(resolve(input.repository, located))) {
        throw new ToolExecutionError(`a revert, cherry-pick, or merge is in progress in this repository (git keeps ${marker}); finish it or abort it first, and git_revert will not touch it`, { code: 'GIT_FAILED' })
      }
    }
  }

  const requireClient = (): ForgeClient => {
    if (!forge.client) throw new ToolExecutionError('This node holds no forge credential; BUCKLE_FORGE_GITHUB_TOKEN is unset', { code: 'FORGE_UNCONFIGURED' })
    return forge.client
  }

  const tools = [
    defineTool(PACK_ID, {
      name: 'git_commit',
      description: 'Stage the named paths and commit them under the node\'s agent identity. Refuses an empty commit.',
      risk: 'write',
      tags: ['git', 'forge'],
      input: commitInput,
      effects: input => [{ kind: 'write_path', path: input.repo }],
      run: async (input, context): Promise<JsonValue> => {
        const repository = judgedPath({ named: input.repo, kind: 'write', paths, context })
        assertRepositoryPaths({ repository, named: input.paths })
        const gitDirectory = ownGitDirectory({ repository, remedy: COMMIT_REMEDY })
        assertNoFilters({ repository, paths: input.paths })
        await assertGitResolvesOwn({ repository, gitDirectory, remedy: COMMIT_REMEDY, context })
        assertNoFilterPrograms({ repository, keys: await filterPrograms({ repository, context }) })
        await gitOutput({ repository, args: ['add', '--', ...input.paths], context })
        await gitOutput({ repository, args: ['commit', '--message', input.message, '--', ...input.paths], extra: identity, context })
        const [hash = '', subject = ''] = (await gitOutput({ repository, args: ['show', '--no-patch', `--format=%H${FIELD_SEPARATOR}%s`, 'HEAD'], context })).trim().split(FIELD_SEPARATOR)
        const files = (await gitOutput({ repository, args: ['show', '--name-only', '--format=', 'HEAD'], context })).split('\n').filter(Boolean)
        return { hash, subject, files }
      },
    }),

    defineTool(PACK_ID, {
      name: 'git_revert',
      description: 'Commit the undoing of one commit (git revert) under the node\'s agent identity; never a reset. A merge commit needs mainline; a dirty tree or a conflict reverts nothing.',
      risk: 'write',
      tags: ['git', 'forge'],
      input: revertInput,
      // A write on the repository, as git_commit's, and a read of it, as git_log's: the commit is read to undo it.
      effects: input => [{ kind: 'write_path', path: input.repo }, { kind: 'read_path', path: input.repo }],
      run: async (input, context): Promise<JsonValue> => {
        const commit = assertRevision(input.commit)
        const repository = judgedPath({ named: input.repo, kind: 'write', paths, context })
        const gitDirectory = ownGitDirectory({ repository, remedy: COMMIT_REMEDY })
        await assertGitResolvesOwn({ repository, gitDirectory, remedy: COMMIT_REMEDY, context })
        const keys = await configuredKeyNames({ spawn: args => runGit({ repository, args, context }), describeFailure: result => scrub(describeProcessFailure('git config --list', result)) })
        assertNoFilterPrograms({ repository, keys: filterProgramKeys(keys) })
        assertNoMergeDrivers({ repository, keys: mergeDriverKeys(keys) })
        const target = await commitToRevert({ repository, commit, mainline: input.mainline, context })
        const files = await revertedPaths({ repository, ...target, mainline: input.mainline, context })
        assertNoFilters({ repository, paths: files })
        await assertNoUnfinishedOperation({ repository, context })
        const reverted = await runGit({ repository, args: ['revert', '--no-edit', ...(input.mainline === undefined ? [] : ['--mainline', String(input.mainline)]), target.hash], extra: identity, context })
        if (reverted.exitCode !== 0) {
          // Only this call's own stopped revert is aborted: none stood before it, and the one git left names the commit it undoes.
          const left = await runGit({ repository, args: ['rev-parse', '--verify', '--quiet', 'REVERT_HEAD'], context })
          const stopped = left.exitCode === 0 && left.stdout.trim() === target.hash
          if (stopped) await gitOutput({ repository, args: ['revert', '--abort'], context })
          throw new ToolExecutionError(scrub(`${describeProcessFailure('git', reverted)}${stopped ? `; ${REVERT_ABORTED}` : ''}`), { code: 'GIT_FAILED' })
        }
        const [hash = '', subject = ''] = (await gitOutput({ repository, args: ['show', '--no-patch', `--format=%H${FIELD_SEPARATOR}%s`, 'HEAD'], context })).trim().split(FIELD_SEPARATOR)
        return { hash, subject, reverted: target.hash, files }
      },
    }),

    defineTool(PACK_ID, {
      name: 'git_push',
      description: 'Push a branch to origin. The forge credential is injected into git\'s environment, never written into the remote URL. Force pushes are refused.',
      risk: 'write',
      tags: ['git', 'forge', 'network'],
      input: pushInput,
      // Under the workspace's write lock, so no call can change the repository's config between the launch
      // checks and git reading it (review H3).
      exclusive: true,
      // The destination is read once, before the rules judge it, and the push goes there or nowhere.
      // A plain-http origin on the forge host is refused here, before any rule judges it or anyone is asked.
      judge: input => assertNoDowngrade(judgedRemote(classifyRemote(readOriginUrl(paths.resolve(input.repo)))), forge),
      effects: (input, destination) => [{ kind: 'read_path', path: input.repo }, remoteEffect(destination)],
      run: async (input, context, destination): Promise<JsonValue> => {
        if (input.force) {
          throw new ToolInputError('git_push refuses force: true by name. Rewriting a published branch is a shell_exec decision the destructive-command gate asks about.', { code: 'PERMISSION_DENIED' })
        }
        const branch = assertBranchName(input.branch)
        const repository = judgedPath({ named: input.repo, kind: 'read', paths, context })
        await assertPushTarget({ repository, pinned: destination, context })
        await assertDestinationUnaliased({ repository, destination, context })
        assertDestinationAllowed({ remote: destination, forge, approved: options.approved, context })
        // To the judged destination by name, never the symbolic origin, which a config change could move
        // after the check. `remote.origin.receivepack` is first-wins in git, so only the command line resets it.
        // A local destination is its absolute real path, which git never reads as a remote name (git refuses a
        // remote named with a leading `/`); an https one has no such spelling, so a remote named by it is refused above.
        // The git receiving a local push runs in the destination without the isolation above, so it is handed its
        // own on its command line (review H1 of the slice 5 re-review), with Buckle's guard as its only hook, which
        // tests the repository it opened before any ref is written (slice 7 review F3).
        const refspec = `refs/heads/${branch}:refs/heads/${branch}`
        // A remote's own stderr is never read as Buckle's refusal: an https push that fails is a failed push.
        const receiving: ReceivingGit = destination.kind === 'local' ? await guardedReceivePack({ repository: destination.path, context }) : { command: 'git-receive-pack', environment: {} }
        // A repository in a mount the owner shares read-only is written nothing, its refs and config included (fix brief
        // 6, item 5): the push is made, and the result says what was left as it was. Git 2.56 writes the remote-tracking
        // ref of the remote whose push URL is the destination, and its reflog, beside the push, so there the push runs on
        // a private copy of the git directory, the objects read in place. Git drops GIT_DIR, GIT_WORK_TREE, and
        // GIT_OBJECT_DIRECTORY from the receive-pack it starts for a local destination (local_repo_env, connect.c), and an
        // https push's receive-pack runs on the remote, so only the pushing git and the helpers it starts read the copy.
        const readOnly = paths.mountOf(repository)?.access === 'ro'
        const source = readOnly ? privateGitDirectory({ repository, stateDirectory: options.stateDirectory, shown: paths.display(repository) }) : null
        // Never into the submodules, whatever `push.recurseSubmodules` or `submodule.recurse` the repository's config sets:
        // git would push each to its own remote, which no rule judged, and run its hooks and programs without the config
        // scope given here, which git strips from the push it starts there (sanitize_repo_env); from a read-only mount it
        // would also write the submodule's remote-tracking ref in the repository's .git/modules, which the copy does not hold.
        try {
          await gitOutput({ repository, args: ['push', '--no-recurse-submodules', `--receive-pack=${receiving.command}`, pushTarget(destination), refspec], config: pushConfig({ remote: destination, forge }), extra: { ...receiving.environment, ...source?.environment }, secrets: userinfoForms(destination), ...(receiving.refusedBy ? { refusedBy: receiving.refusedBy } : {}), context })
        } finally { source?.remove() }
        const headSha = (await gitOutput({ repository, args: ['rev-parse', '--verify', `refs/heads/${branch}`], context })).trim()
        if (readOnly) {
          return { branch, remote: destination.display, headSha, note: `The repository is in a mount the owner shares read-only, so git_push moved no remote-tracking ref${input.setUpstream ? ' and set no upstream' : ''} in it` }
        }
        // Git before 2.56 moves no remote-tracking ref for a push to a URL or a path; git 2.56 moves that of the one remote
        // whose push URL is that same string, origin's when origin spells the destination as it is pushed to. Origin
        // named this destination at launch, so its ref follows, whichever git ran.
        await gitOutput({ repository, args: ['update-ref', `refs/remotes/origin/${branch}`, headSha], context })
        if (input.setUpstream) {
          await gitOutput({ repository, args: ['config', `branch.${branch}.remote`, 'origin'], context })
          await gitOutput({ repository, args: ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], context })
        }
        return { branch, remote: destination.display, headSha }
      },
    }),

    defineTool(PACK_ID, {
      name: 'pr_open',
      description: 'Open a pull request on the forge behind origin. The head branch must already be pushed.',
      risk: 'write',
      tags: ['forge', 'network'],
      input: openInput,
      effects: input => [{ kind: 'read_path', path: input.repo }, { kind: 'network', url: forge.apiUrl }],
      run: async (input, context): Promise<JsonValue> => {
        const client = requireClient()
        const repository = judgedPath({ named: input.repo, kind: 'read', paths, context })
        const target = forgeRepository(repository)
        const pushed = await runGit({ repository, args: ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${assertBranchName(input.head)}`], context })
        if (pushed.exitCode !== 0) {
          throw new ToolInputError(`${input.head} is not on origin yet; git_push it before opening a pull request`, { code: 'FORGE_HEAD_NOT_PUSHED' })
        }
        const pull = await client.openPullRequest({ repository: target, head: input.head, base: input.base, title: input.title, body: input.body, signal: context.signal })
        return { number: pull.number, url: pull.url, headSha: pull.head.sha, state: pull.state }
      },
    }),

    defineTool(PACK_ID, {
      name: 'pr_read',
      description: 'Read a pull request, optionally with its diff, changed files and comments.',
      risk: 'read',
      tags: ['forge', 'network'],
      input: readInput,
      effects: input => [{ kind: 'read_path', path: input.repo }, { kind: 'network', url: forge.apiUrl }],
      run: async (input, context): Promise<JsonValue> => {
        const client = requireClient()
        const target = forgeRepository(judgedPath({ named: input.repo, kind: 'read', paths, context }))
        const request = { repository: target, number: input.number, signal: context.signal }
        const pull = await client.readPullRequest(request)
        const result: JsonObject = {
          number: pull.number,
          state: pull.state,
          title: pull.title,
          head: { ref: pull.head.ref, sha: pull.head.sha },
          base: { ref: pull.base.ref, sha: pull.base.sha },
        }
        if (input.include.includes('diff')) {
          const diff = await client.readPullRequestDiff({ ...request, maxBytes: MAX_DIFF_BYTES })
          result.diff = diff.diff
          result.diffTruncated = diff.truncated
        }
        if (input.include.includes('files')) {
          result.files = (await client.readPullRequestFiles(request)).map(file => ({ ...file }))
        }
        if (input.include.includes('comments')) {
          result.comments = (await client.readPullRequestComments(request)).map(comment => ({ ...comment }))
        }
        return scrubJson(result)
      },
    }),
  ]

  return {
    id: PACK_ID,
    version: '1.0.0',
    tools,
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: options.unavailableReason,
  }
}

/**
 * A push to an https remote is a network reach the egress rule must judge; a push to a
 * repository on this filesystem is a write, and is judged as one, at its host path (review L4).
 */
function remoteEffect(remote: ForgeRemote): ToolEffect {
  return remote.kind === 'https'
    ? { kind: 'network', url: remote.url.origin }
    : { kind: 'write_path', path: remote.path, host: true }
}

/** A destination as the rules judge it: a local repository by its real path, so a link moved later is not followed. */
function judgedRemote(remote: ForgeRemote): ForgeRemote {
  if (remote.kind !== 'local') return remote
  const path = resolveTarget(remote.path)
  return { kind: 'local', path, display: path }
}

/** What makes two destinations the same repository: an https remote's scheme, host, port and path, a local one's real path. */
function destinationOf(remote: ForgeRemote): string {
  return remote.kind === 'https' ? remoteSubject(remote) : `local:${remote.path}`
}

/** What git is handed to push to: the judged URL without userinfo (the credential rides in a scoped header), or the real path. */
function pushTarget(remote: ForgeRemote): string {
  return remote.kind === 'https' ? remote.display : remote.path
}

interface PushUrl {
  /** The URL as written, so a rewrite shows up as a value git changed. */
  raw: string
  remote: ForgeRemote
}

/**
 * A rewrite rule is config deciding where a push lands, which is the decision the permission
 * rules were asked about. Rewritten or not, the target has to be the one the config names.
 */
function assertNoRewrite(input: { configured: PushUrl; actual: PushUrl }): void {
  if (input.configured.raw.trim() === input.actual.raw.trim()) return
  throw new ToolInputError(`an insteadOf or pushInsteadOf rule rewrites origin ${input.configured.remote.display} before the push; the push is refused rather than sent to a target the permission rules never saw`, { code: 'PERMISSION_DENIED' })
}

/**
 * What the one git call that reaches the network is configured with. The credential is scoped to
 * the single origin URL it belongs to, so a redirect to another repository, even on the same
 * host, is served no header at all, and the proxy and TLS resets are repeated at that same scope
 * because a URL-scoped key in the repository config outranks the plain one. On the forge host the
 * credential is the forge token; elsewhere it is the userinfo the approved origin names, since git is
 * handed the URL without it and isolation leaves git no helper or prompt to ask (review M4).
 */
function pushConfig(input: { remote: ForgeRemote; forge: ForgePackOptions['forge'] }): GitConfig[] {
  if (input.remote.kind !== 'https') return []
  // `display` is the URL without userinfo, which is the form git matches a request against.
  const scope = input.remote.display.replace(/\/+$/, '')
  const transport = transportConfig(scope)
  const credential = isForgeEndpoint(input.remote, input.forge) ? basicCredential(input.forge.token) : userinfoCredential(input.remote.url)
  if (credential === null) return transport
  return [...transport, { key: `http.${scope}.extraheader`, value: `Authorization: Basic ${credential}` }]
}

/** The origin's own userinfo as a Basic credential, or null when it names none. */
function userinfoCredential(url: URL): string | null {
  if (!url.username && !url.password) return null
  return Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
}

/** Every form of a destination's userinfo that could reach text a caller sees, so each is stripped from git's answers. */
function userinfoForms(remote: ForgeRemote): string[] {
  if (remote.kind !== 'https') return []
  const credential = userinfoCredential(remote.url)
  if (credential === null) return []
  const user = decodeURIComponent(remote.url.username)
  const password = decodeURIComponent(remote.url.password)
  return [credential, `${user}:${password}`, password, remote.url.password].filter(form => form.length > 0)
}

/** `remote.<name>.<key>`: the name is everything between the first and the last dot. */
function remoteNameOf(key: string): string {
  return key.slice('remote.'.length, key.lastIndexOf('.'))
}

/**
 * Every spelling of the destination a remote could be named by and still stand for it: the target git is
 * handed and, for a local repository, origin's path as typed, each with or without a trailing `.git` or `/`
 * (review L8 of the slice 5 re-review). Git itself matches the argument exactly; the other spellings are refused
 * too, since a person reading the config would take them for the destination.
 */
function destinationSpellings(input: { destination: ForgeRemote; typed: ForgeRemote }): Set<string> {
  const spellings = [pushTarget(input.destination), ...(input.typed.kind === 'local' ? [input.typed.path] : [])]
  return new Set(spellings.map(sameRepositoryName))
}

/** A remote name or a destination with any trailing `/` and one trailing `.git` dropped, so the two forms compare equal. */
function sameRepositoryName(name: string): string {
  return name.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

/**
 * GitHub's git endpoint authenticates a personal access token as Basic auth and refuses a bearer
 * there, while its REST API takes the bearer. The encoded form is a credential in its own right,
 * so both forms are stripped from anything a caller sees.
 */
function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64')
}

function credentialForms(token: string): string[] {
  return token ? [token, basicCredential(token)] : []
}

/** The forge's own git endpoint, by which the credential's destination is judged. */
type ForgeEndpoint = Pick<ForgePackOptions['forge'], 'apiUrl' | 'gitHost'>

/**
 * Whether a remote is the forge's own git endpoint: its git host, over the scheme and on the effective port of its API
 * (https on 443 for GitHub). The forge credential goes there alone, so an `http://` origin on the forge host never
 * carries it in clear text, whoever answers on port 80.
 */
function isForgeEndpoint(remote: ForgeRemote, forge: ForgeEndpoint): boolean {
  if (remote.kind !== 'https') return false
  const api = new URL(forge.apiUrl)
  return remote.host === forge.gitHost && remote.url.protocol === api.protocol && effectivePort(remote.url) === effectivePort(api)
}

/**
 * An origin on the forge host over another scheme than the forge's own (`http://` beside an https API) is refused: it
 * names the forge, so a push there would be a push to it without the transport its credential is meant for.
 */
function assertNoDowngrade(remote: ForgeRemote, forge: ForgeEndpoint): ForgeRemote {
  if (remote.kind !== 'https' || remote.host !== forge.gitHost) return remote
  const api = new URL(forge.apiUrl)
  if (remote.url.protocol === api.protocol) return remote
  throw new ToolInputError(`origin is ${remote.display}, on the forge host ${forge.gitHost} over ${remote.url.protocol.slice(0, -1)}; the forge is reached over ${api.protocol.slice(0, -1)} alone, and its credential is never sent another way, so this push is refused`, { code: 'PERMISSION_DENIED' })
}

/** A pull request is opened and read on the forge the credential belongs to, wherever origin points. */
function assertForgeHost(input: { remote: ForgeRemote; forge: ForgeEndpoint }): void {
  if (isForgeEndpoint(input.remote, input.forge)) return
  throw new ToolInputError(`origin is ${input.remote.display}, and the configured forge is ${new URL(input.forge.apiUrl).protocol}//${input.forge.gitHost}; the pull-request tools act on that forge alone, so this repository is refused`, { code: 'PERMISSION_DENIED' })
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

/**
 * The destination policy, for a local destination too: a repository on this filesystem is pushed to only
 * where the call's permission check judged a write (GPT review of c71dee5), an https one only on the forge
 * host or the owner's approved list.
 */
function assertDestinationAllowed(input: { remote: ForgeRemote; forge: ForgeEndpoint; approved: UrlMatcher | null; context: Pick<ToolContext, 'authorizeWrite'> }): void {
  const { remote } = input
  if (remote.kind === 'local') {
    if (!input.context.authorizeWrite || input.context.authorizeWrite(remote.path)) return
    throw new ToolInputError(`origin is ${remote.display}, a repository on this filesystem the permission check did not judge as a write; send the call again`, { code: 'PERMISSION_DENIED' })
  }
  assertNoDowngrade(remote, input.forge)
  if (isForgeEndpoint(remote, input.forge)) return
  if (input.approved?.matches(remote.url)) return
  throw new ToolInputError(`origin is ${remote.display}, and the configured forge host is ${input.forge.gitHost}. Pushing elsewhere needs that host on this workspace's approved URL list (the owner runs \`buckle policy allow-url <host>\`), and the forge credential is never sent there.`, { code: 'PERMISSION_DENIED' })
}

function assertRevision(commit: string): string {
  if (!REVISION_PATTERN.test(commit) || commit.includes('..') || commit.endsWith('.lock')) {
    throw new ToolInputError(`Not a usable commit name: ${commit}; name one commit, by its hash or a revision such as HEAD~1`)
  }
  return commit
}

function assertBranchName(branch: string): string {
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    throw new ToolInputError(`Not a usable branch name: ${branch}`)
  }
  return branch
}

/** A committed path is named relative to the repository, so no commit can reach outside it. */
function assertRepositoryPaths(input: { repository: string; named: string[] }): void {
  for (const named of input.named) {
    if (isAbsolute(named) || !isInside(input.repository, resolve(input.repository, named))) {
      throw new ToolInputError(`Commit paths are relative to the repository, and ${named} is not inside it`, { code: 'PERMISSION_DENIED' })
    }
  }
}
