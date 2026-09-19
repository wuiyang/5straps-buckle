import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { ToolEffect } from '../../domain/effect.js'
import type { ForgeClient } from '../../domain/forge.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { isInside } from '../../domain/paths.js'
import { stripSecret } from '../../domain/redact.js'
import { defineTool, ToolExecutionError, ToolInputError, type ToolContext } from '../../domain/tool.js'
import type { UrlMatcher } from '../../domain/url-pattern.js'
import type { ProcessResult, ProcessRunner } from '../../ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { describeProcessFailure } from '../process-failure.js'
import { classifyRemote, readOriginUrl, repositoryOf, type ForgeRemote } from './remote.js'

const PACK_ID = 'forge'
const MAX_DIFF_BYTES = 524_288
/** Unit separator: safe inside a commit subject, unlike any printable delimiter. */
const FIELD_SEPARATOR = '\x1f'
/** No leading dash, so a branch can never be read as a flag, and no `..` or ref-name punctuation. */
const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

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

const readInput = repoInput.extend({
  number: z.number().int().min(1),
  include: z.array(z.enum(['diff', 'comments', 'files'])).max(3).default([]),
})

export interface ForgePackOptions {
  paths: PathView
  runProcess: ProcessRunner
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

export function createForgePack(options: ForgePackOptions): Pack {
  const { forge, paths } = options

  const runGit = async (input: { repository: string; args: string[]; extra?: Record<string, string>; context: ToolContext }): Promise<ProcessResult> => {
    return await options.runProcess({
      command: 'git',
      args: input.args,
      cwd: input.repository,
      timeoutMs: input.context.timeoutMs,
      environment: buildChildEnvironment({ parent: process.env, extra: { GIT_TERMINAL_PROMPT: '0', ...input.extra } }),
      signal: input.context.signal,
    })
  }

  const gitOutput = async (input: { repository: string; args: string[]; extra?: Record<string, string>; context: ToolContext }): Promise<string> => {
    const result = await runGit(input)
    if (result.exitCode !== 0) {
      throw new ToolExecutionError(stripSecret(describeProcessFailure('git', result), forge.token), { code: 'GIT_FAILED' })
    }
    return stripSecret(result.stdout, forge.token)
  }

  /** The remote git itself would push to, which is what settles any rewrite rule config carries. */
  const resolvePushRemote = async (input: { repository: string; context: ToolContext }): Promise<ForgeRemote> => {
    const declared = classifyRemote(readOriginUrl(input.repository))
    const actual = classifyRemote(await gitOutput({ ...input, args: ['remote', 'get-url', '--push', 'origin'] }))
    if (remoteSubject(actual) !== remoteSubject(declared)) {
      throw new ToolInputError(`origin resolves to ${actual.display}, not the ${declared.display} the permission rules judged; the push is refused rather than sent somewhere unjudged`, { code: 'PERMISSION_DENIED' })
    }
    assertRemoteAllowed({ remote: actual, gitHost: forge.gitHost, approved: options.approved })
    return actual
  }

  const forgeRepository = (repository: string) => repositoryOf(classifyRemote(readOriginUrl(repository)))

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
        const repository = paths.resolve(input.repo)
        assertRepositoryPaths({ repository, named: input.paths })
        const identity = {
          GIT_AUTHOR_NAME: options.author.name,
          GIT_AUTHOR_EMAIL: options.author.email,
          GIT_COMMITTER_NAME: options.author.name,
          GIT_COMMITTER_EMAIL: options.author.email,
        }
        await gitOutput({ repository, args: ['add', '--', ...input.paths], context })
        await gitOutput({ repository, args: ['commit', '--message', input.message, '--', ...input.paths], extra: identity, context })
        const [hash = '', subject = ''] = (await gitOutput({ repository, args: ['show', '--no-patch', `--format=%H${FIELD_SEPARATOR}%s`, 'HEAD'], context })).trim().split(FIELD_SEPARATOR)
        const files = (await gitOutput({ repository, args: ['show', '--name-only', '--format=', 'HEAD'], context })).split('\n').filter(Boolean)
        return { hash, subject, files }
      },
    }),

    defineTool(PACK_ID, {
      name: 'git_push',
      description: 'Push a branch to origin. The forge credential is injected into git\'s environment, never written into the remote URL. Force pushes are refused.',
      risk: 'write',
      tags: ['git', 'forge', 'network'],
      input: pushInput,
      effects: input => [{ kind: 'read_path', path: input.repo }, remoteEffect(paths.resolve(input.repo))],
      run: async (input, context): Promise<JsonValue> => {
        if (input.force) {
          throw new ToolInputError('git_push refuses force: true by name. Rewriting a published branch is a shell_exec decision the destructive-command gate asks about.', { code: 'PERMISSION_DENIED' })
        }
        const branch = assertBranchName(input.branch)
        const repository = paths.resolve(input.repo)
        const remote = await resolvePushRemote({ repository, context })
        const args = ['push', ...(input.setUpstream ? ['--set-upstream'] : []), 'origin', branch]
        await gitOutput({ repository, args, extra: credentialEnvironment({ remote, forge }), context })
        const headSha = (await gitOutput({ repository, args: ['rev-parse', '--verify', `refs/heads/${branch}`], context })).trim()
        return { branch, remote: remote.display, headSha }
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
        const repository = paths.resolve(input.repo)
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
        const target = forgeRepository(paths.resolve(input.repo))
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
        return result
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
 * repository on this filesystem is a write, and is judged as one.
 */
function remoteEffect(repository: string): ToolEffect {
  const remote = classifyRemote(readOriginUrl(repository))
  return remote.kind === 'https'
    ? { kind: 'network', url: remote.url.origin }
    : { kind: 'write_path', path: remote.path }
}

function remoteSubject(remote: ForgeRemote): string {
  return remote.kind === 'https' ? `${remote.host}:${remote.url.port}` : remote.path
}

/** The credential reaches the forge host alone, and only through git's environment. */
function credentialEnvironment(input: { remote: ForgeRemote; forge: ForgePackOptions['forge'] }): Record<string, string> {
  if (input.remote.kind !== 'https' || input.remote.host !== input.forge.gitHost) return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.forge.token}`,
  }
}

function assertRemoteAllowed(input: { remote: ForgeRemote; gitHost: string; approved: UrlMatcher | null }): void {
  if (input.remote.kind !== 'https' || input.remote.host === input.gitHost) return
  if (input.approved?.matches(input.remote.url)) return
  throw new ToolInputError(`origin is ${input.remote.display}, and the configured forge host is ${input.gitHost}. Pushing elsewhere needs that host on BUCKLE_NETWORK_ALLOW, and the forge credential is never sent there.`, { code: 'PERMISSION_DENIED' })
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
