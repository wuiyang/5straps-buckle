import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { ToolEffect } from '../../domain/effect.js'
import type { ForgeClient, ForgeRepository } from '../../domain/forge.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { isInside } from '../../domain/paths.js'
import { stripSecret } from '../../domain/redact.js'
import { defineTool, ToolExecutionError, ToolInputError, type ToolContext } from '../../domain/tool.js'
import type { UrlMatcher } from '../../domain/url-pattern.js'
import type { ProcessResult, ProcessRunner } from '../../ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { describeProcessFailure } from '../process-failure.js'
import { assertNoFilters, gitConfigEnvironment, isolationConfig, ISOLATION_ENVIRONMENT, transportConfig, type GitConfig } from './isolation.js'
import { classifyRemote, readOriginUrl, remoteSubject, repositoryOf, type ForgeRemote } from './remote.js'

const PACK_ID = 'forge'
const MAX_DIFF_BYTES = 524_288
/** Empty, Buckle-owned, and where `core.hooksPath` points, so no hook the workspace wrote runs. */
const HOOKS_DIRECTORY = 'forge-hooks'
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

export function createForgePack(options: ForgePackOptions): Pack {
  const { forge, paths } = options
  const hooksDirectory = join(options.stateDirectory, HOOKS_DIRECTORY)

  /** Without it there is nothing to point git's hooks at, so git is not run at all. */
  const ensureHooksDirectory = (): string => {
    try {
      mkdirSync(hooksDirectory, { recursive: true, mode: 0o700 })
    } catch {
      throw new ToolExecutionError(`Buckle could not create its empty hooks directory at ${hooksDirectory}; git is not run with the workspace's hooks in reach`, { code: 'FORGE_ISOLATION_UNAVAILABLE' })
    }
    return hooksDirectory
  }

  const runGit = async (input: { repository: string; args: string[]; config?: GitConfig[]; extra?: Record<string, string>; context: ToolContext }): Promise<ProcessResult> => {
    const config = [...isolationConfig(ensureHooksDirectory()), ...(input.config ?? [])]
    return await options.runProcess({
      command: 'git',
      args: input.args,
      cwd: input.repository,
      timeoutMs: input.context.timeoutMs,
      environment: buildChildEnvironment({ parent: process.env, extra: { ...ISOLATION_ENVIRONMENT, ...gitConfigEnvironment(config), ...input.extra } }),
      signal: input.context.signal,
    })
  }

  const scrub = (text: string): string => credentialForms(forge.token).reduce(stripSecret, text)

  const gitOutput = async (input: { repository: string; args: string[]; config?: GitConfig[]; extra?: Record<string, string>; context: ToolContext }): Promise<string> => {
    const result = await runGit(input)
    if (result.exitCode !== 0) throw new ToolExecutionError(scrub(describeProcessFailure('git', result)), { code: 'GIT_FAILED' })
    return scrub(result.stdout)
  }

  /** Absent config is exit 1, which is an answer rather than a failure. */
  const configValues = async (input: { repository: string; key: string; context: ToolContext }): Promise<string[]> => {
    const result = await runGit({ repository: input.repository, args: ['config', '--get-all', input.key], context: input.context })
    if (result.exitCode === 1) return []
    if (result.exitCode !== 0) throw new ToolExecutionError(scrub(describeProcessFailure('git', result)), { code: 'GIT_FAILED' })
    return nonEmptyLines(scrub(result.stdout))
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

  /** The remote git itself would push to, which is what settles any rewrite rule config carries. */
  const resolvePushRemote = async (input: { repository: string; context: ToolContext }): Promise<ForgeRemote> => {
    const declared = classifyRemote(readOriginUrl(input.repository))
    const configured = await readConfiguredPushUrl(input)
    const actual = await readResolvedPushUrl(input)
    assertNoRewrite({ configured, actual })
    if (remoteSubject(actual.remote) !== remoteSubject(declared)) {
      throw new ToolInputError(`origin resolves to ${actual.remote.display}, not the ${declared.display} the permission rules judged; the push is refused rather than sent somewhere unjudged`, { code: 'PERMISSION_DENIED' })
    }
    assertRemoteAllowed({ remote: actual.remote, gitHost: forge.gitHost, approved: options.approved })
    return actual.remote
  }

  const forgeRepository = (repository: string): ForgeRepository => {
    const remote = classifyRemote(readOriginUrl(repository))
    assertForgeHost({ remote, gitHost: forge.gitHost })
    return repositoryOf(remote)
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
        const repository = paths.resolve(input.repo)
        assertRepositoryPaths({ repository, named: input.paths })
        assertNoFilters({ repository, paths: input.paths })
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
        // `remote.origin.receivepack` is first-wins in git, so only the command line can reset it.
        const args = ['push', '--receive-pack=git-receive-pack', ...(input.setUpstream ? ['--set-upstream'] : []), 'origin', branch]
        await gitOutput({ repository, args, config: pushConfig({ remote, forge }), context })
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
 * the single origin URL it belongs to, so a redirect to another repository — even on the same
 * host — is served no header at all, and the proxy and TLS resets are repeated at that same scope
 * because a URL-scoped key in the repository config outranks the plain one.
 */
function pushConfig(input: { remote: ForgeRemote; forge: ForgePackOptions['forge'] }): GitConfig[] {
  if (input.remote.kind !== 'https') return []
  // `display` is the URL without userinfo, which is the form git matches a request against.
  const scope = input.remote.display.replace(/\/+$/, '')
  const transport = transportConfig(scope)
  if (input.remote.host !== input.forge.gitHost) return transport
  return [...transport, { key: `http.${scope}.extraheader`, value: `Authorization: Basic ${basicCredential(input.forge.token)}` }]
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

/** A pull request is opened and read on the forge the credential belongs to, wherever origin points. */
function assertForgeHost(input: { remote: ForgeRemote; gitHost: string }): void {
  if (input.remote.kind === 'https' && input.remote.host === input.gitHost) return
  throw new ToolInputError(`origin is ${input.remote.display}, and the configured forge is ${input.gitHost}; the pull-request tools act on that forge alone, so this repository is refused`, { code: 'PERMISSION_DENIED' })
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
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
