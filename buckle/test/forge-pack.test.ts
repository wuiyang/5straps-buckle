import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createSocketServer, type AddressInfo } from 'node:net'
import { join } from 'pathe'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createGitHubForgeClient } from '../common/adapters/forge/github.js'
import { runProcess } from '../common/adapters/process-runner.js'
import { loadConfig } from '../common/runtime/config.js'
import { forgeGitHost } from '../common/domain/forge.js'
import { createPathView } from '../common/domain/path-view.js'
import { compileUrlPatterns } from '../common/domain/url-pattern.js'
import { createForgePack, type ForgePackOptions } from '../common/services/packs/forge/index.js'
import { guardedReceivePackCommand } from '../common/services/packs/forge/receive-pack-guard.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'
import type { ToolContext } from '../common/domain/tool.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { resolveEffects } from '../common/services/invocation/resolve-effects.js'
import type { PathView } from '../common/domain/path-view.js'
import { startGitHttp, type GitHttpServer } from './support/git-http.js'

/**
 * The runtime's process runner, passed through, with a hook a test may set to act just before git is
 * spawned for a push: where a change between the launch checks and git reading its config would land.
 */
const spawnHook = vi.hoisted(() => ({ beforePush: null as null | (() => Promise<void>) }))
vi.mock('../common/adapters/process-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/process-runner.js')>()
  return {
    ...actual,
    runProcess: async (request: Parameters<typeof actual.runProcess>[0]) => {
      if (request.command === 'git' && request.args[0] === 'push' && spawnHook.beforePush) await spawnHook.beforePush()
      return await actual.runProcess(request)
    },
  }
})

const TOKEN = 'ghp-forge-pack-secret-value'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
const roots: string[] = []

let server: Server
let apiUrl: string
/** Every Authorization header the scripted forge saw, so a missing bearer fails loudly. */
const seenAuthorization: string[] = []

beforeAll(async () => {
  server = await startForgeServer()
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => { server.close() })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function startForgeServer(): Promise<Server> {
  const pull = (number: number, state = 'open') => ({
    number, html_url: `https://github.com/5straps/demo/pull/${number}`, state, title: 'collapse separators',
    head: { ref: 'forge-live-check', sha: 'a'.repeat(40) },
    base: { ref: 'main', sha: 'b'.repeat(40) },
  })

  const scripted = createServer((request, response) => {
    seenAuthorization.push(request.headers.authorization ?? '')
    const path = (request.url ?? '').split('?')[0] ?? ''
    const send = (status: number, body: string, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type })
      response.end(body)
    }
    // A forge that echoes the credential back is exactly what the stripping has to survive.
    if (path.startsWith('/repos/leaky/')) return send(403, JSON.stringify({ message: `bad credentials: ${TOKEN}` }))
    if (path === '/repos/5straps/demo/pulls' && request.method === 'POST') {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => send(201, JSON.stringify({ ...pull(7), title: (JSON.parse(body) as { title: string }).title })))
      return undefined
    }
    if (path === '/repos/5straps/demo/pulls/7') {
      if (request.headers.accept === 'application/vnd.github.v3.diff') return send(200, `${'d'.repeat(600_000)}\n`, 'text/plain')
      return send(200, JSON.stringify(pull(7)))
    }
    // A pull request whose every field carries the credential, in both forms git and REST see.
    if (path === '/repos/5straps/demo/pulls/8') {
      if (request.headers.accept === 'application/vnd.github.v3.diff') return send(200, `+token=${TOKEN}\n+basic=${BASIC}\n`, 'text/plain')
      return send(200, JSON.stringify({ ...pull(8), title: `leak ${TOKEN}`, head: { ref: 'forge-live-check', sha: 'a'.repeat(40) } }))
    }
    if (path === '/repos/5straps/demo/pulls/8/files') return send(200, JSON.stringify([{ filename: `src/${TOKEN}.js`, status: 'modified', additions: 1, deletions: 0 }]))
    if (path === '/repos/5straps/demo/issues/8/comments') return send(200, JSON.stringify([{ user: { login: `bot-${BASIC}` }, created_at: '2026-09-24T00:00:00Z', body: `here is ${TOKEN}` }]))
    if (path === '/repos/5straps/demo/pulls/7/files') return send(200, JSON.stringify([{ filename: 'src/slugify.js', status: 'modified', additions: 3, deletions: 1 }]))
    if (path === '/repos/5straps/demo/issues/7/comments') return send(200, JSON.stringify([{ user: { login: '5straps' }, created_at: '2026-09-20T00:00:00Z', body: 'looks right' }]))
    return send(404, JSON.stringify({ message: 'no such route' }))
  })
  return new Promise(resolve => scripted.listen(0, '127.0.0.1', () => resolve(scripted)))
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(`/tmp/buckle-forge-${prefix}-`)
  roots.push(root)
  return root
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
}

/** A work repository whose origin is whatever the caller needs judged. */
function workRepository(input: { origin: string }): string {
  const root = temporaryRoot('repo')
  const repository = join(root, 'work')
  execFileSync('git', ['init', '-b', 'main', repository])
  git(repository, 'remote', 'add', 'origin', input.origin)
  return repository
}

function bareOrigin(): { origin: string; repository: string } {
  const root = temporaryRoot('local')
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin])
  const repository = join(root, 'work')
  execFileSync('git', ['init', '-b', 'main', repository])
  git(repository, 'remote', 'add', 'origin', origin)
  return { origin, repository }
}

function pack(input: { repository: string; token?: string; runner?: typeof runProcess; approved?: string[]; paths?: PathView; stateDirectory?: string }) {
  const token = input.token ?? TOKEN
  const options: ForgePackOptions = {
    paths: input.paths ?? createPathView({ root: input.repository, mount: null }),
    runProcess: input.runner ?? runProcess,
    stateDirectory: input.stateDirectory ?? temporaryRoot('state'),
    forge: {
      client: token ? createGitHubForgeClient({ token, apiUrl }) : null,
      apiUrl,
      gitHost: forgeGitHost(new URL(apiUrl)),
      token,
    },
    author: { name: '5straps agent', email: 'agent@5straps.local' },
    approved: input.approved ? compileUrlPatterns(input.approved) : null,
    unavailableReason: null,
  }
  return createForgePack(options)
}

async function call(input: { repository: string; tool: string; args: JsonObject; token?: string; runner?: typeof runProcess; approved?: string[]; paths?: PathView; stateDirectory?: string }): Promise<JsonValue> {
  const built = pack(input)
  const tool = built.tools.find(candidate => candidate.capability.name === input.tool)
  if (!tool) throw new Error(`the forge pack registered no ${input.tool}`)
  return await tool.prepare(input.args).execute({
    requestId: 'r1', sessionId: 's1', timeoutMs: 20_000, signal: AbortSignal.timeout(20_000),
  })
}

function effectsOf(input: { repository: string; tool: string; args: JsonObject }) {
  const built = pack({ repository: input.repository })
  const tool = built.tools.find(candidate => candidate.capability.name === input.tool)
  if (!tool) throw new Error(`the forge pack registered no ${input.tool}`)
  return tool.prepare(input.args).effects
}

describe('git_commit', () => {
  it('commits only the named paths, under the identity the owner configured', async () => {
    const { repository } = bareOrigin()
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    writeFileSync(join(repository, 'left.txt'), 'left\n')
    const output = await call({ repository, tool: 'git_commit', args: { message: 'add kept', paths: ['kept.txt'] } }) as JsonObject
    expect(output.subject).toBe('add kept')
    expect(output.files).toEqual(['kept.txt'])
    expect(String(output.hash)).toMatch(/^[0-9a-f]{40}$/)
    expect(git(repository, 'log', '-1', '--format=%an <%ae>').trim()).toBe('5straps agent <agent@5straps.local>')
    expect(git(repository, 'status', '--porcelain')).toContain('left.txt')
  })

  it('declares a write on the repository, so the write gate judges it', () => {
    const { repository } = bareOrigin()
    expect(effectsOf({ repository, tool: 'git_commit', args: { message: 'm', paths: ['a.txt'] } })).toEqual([{ kind: 'write_path', path: '.' }])
  })

  it('refuses an empty commit, carrying git\'s own explanation', async () => {
    const { repository } = bareOrigin()
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })
    await expect(call({ repository, tool: 'git_commit', args: { message: 'again', paths: ['kept.txt'] } }))
      .rejects.toThrow(/nothing to commit|no changes added/i)
  })

  it('refuses a path outside the repository', async () => {
    const { repository } = bareOrigin()
    await expect(call({ repository, tool: 'git_commit', args: { message: 'escape', paths: ['../outside.txt'] } }))
      .rejects.toThrow(/not inside it/)
  })

  it('refuses a repository defining a clean filter, before git is spawned at all', async () => {
    const { repository } = bareOrigin()
    const marker = seedCleanFilter(repository)
    writeFileSync(join(repository, '.gitattributes'), '* filter=pwn\n')
    const calls: ProcessRequest[] = []

    await expect(call({ repository, tool: 'git_commit', args: { message: 'm', paths: ['kept.txt'] }, runner: recordingGit(calls) }))
      .rejects.toThrow(/filter driver/)
    expect(calls).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a .gitattributes that gives a committed path a filter attribute', async () => {
    const { repository } = bareOrigin()
    mkdirSync(join(repository, 'src'))
    writeFileSync(join(repository, 'src', '.gitattributes'), '*.js filter=pwn\n')
    writeFileSync(join(repository, 'src', 'kept.js'), 'kept\n')

    await expect(call({ repository, tool: 'git_commit', args: { message: 'm', paths: ['src/kept.js'] } }))
      .rejects.toThrow(/filter attribute/)
  })

  /**
   * `extensions.worktreeConfig` turns on `.git/config.worktree`, a scope the text of `.git/config`
   * does not name, and staging a directory reaches a `.gitattributes` below the named path. Neither
   * is refused by reading that one file, so the driver and the attribute together had a clean
   * program of the workspace's running on the host under a write-risk tool. The keys come from git
   * itself now, which resolves every scope.
   */
  it('refuses a filter driver defined in the worktree config scope, attributed from a nested directory', async () => {
    const { repository } = bareOrigin()
    const marker = join(repository, 'filter-ran.txt')
    writeFileSync(join(repository, 'clean.sh'), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 })
    mkdirSync(join(repository, 'src', 'deep'), { recursive: true })
    writeFileSync(join(repository, 'src', 'deep', '.gitattributes'), '*.js filter=pwn\n')
    writeFileSync(join(repository, 'src', 'deep', 'kept.js'), 'kept\n')
    git(repository, 'config', 'extensions.worktreeConfig', 'true')
    writeFileSync(join(repository, '.git', 'config.worktree'), `[filter "pwn"]\n\tclean = ${join(repository, 'clean.sh')}\n`)

    await expect(call({ repository, tool: 'git_commit', args: { message: 'm', paths: ['src'] } }))
      .rejects.toThrow(/filter/)
    expect(existsSync(marker)).toBe(false)
  })

  it('commits without running a gpg program the repository configured', async () => {
    const { repository } = bareOrigin()
    const marker = join(repository, 'gpg-ran.txt')
    writeFileSync(join(repository, 'gpg.sh'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 })
    git(repository, 'config', 'commit.gpgSign', 'true')
    git(repository, 'config', 'gpg.program', join(repository, 'gpg.sh'))
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')

    const output = await call({ repository, tool: 'git_commit', args: { message: 'unsigned', paths: ['kept.txt'] } }) as JsonObject
    expect(output.subject).toBe('unsigned')
    expect(existsSync(marker)).toBe(false)
  })
})

/** A repository that runs a marker-writing program while staging, if anything lets it. */
function seedCleanFilter(repository: string): string {
  const marker = join(repository, 'filter-ran.txt')
  writeFileSync(join(repository, 'clean.sh'), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 })
  writeFileSync(join(repository, 'kept.txt'), 'kept\n')
  git(repository, 'config', 'filter.pwn.clean', join(repository, 'clean.sh'))
  return marker
}

/** Records what would have been spawned, so a guard that refuses too late shows up as a call. */
function recordingGit(calls: ProcessRequest[]): typeof runProcess {
  return async (request): Promise<ProcessResult> => {
    calls.push(request)
    return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }
  }
}

/** An http origin recording the paths git asks it for: a push that took a proxy shows as silence here. */
function recordingOrigin(): Promise<{ url: string; paths: string[]; close: () => void }> {
  const paths: string[] = []
  const origin = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('no such repository')
  })
  return new Promise(resolve => origin.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(origin.address() as AddressInfo).port}`,
    paths,
    close: () => { origin.close() },
  })))
}

/** An attacker's proxy: anything reaching it is the scoped credential header leaving the node. */
function recordingProxy(): Promise<{ url: string; connections: () => number; close: () => void }> {
  let connections = 0
  const proxy = createSocketServer(socket => { connections += 1; socket.destroy() })
  return new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    connections: () => connections,
    close: () => { proxy.close() },
  })))
}

describe('git_push', () => {
  it('pushes to a repository on this filesystem without any credential', async () => {
    const { origin, repository } = bareOrigin()
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })
    const output = await call({ repository, tool: 'git_push', args: { branch: 'main', setUpstream: true } }) as JsonObject
    expect(output).toMatchObject({ branch: 'main', remote: origin })
    expect(String(output.headSha)).toMatch(/^[0-9a-f]{40}$/)
    expect(execFileSync('git', ['-C', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(output.headSha)
  })

  it('declares a write on a local remote and a network reach on an https one', () => {
    const { origin, repository } = bareOrigin()
    expect(effectsOf({ repository, tool: 'git_push', args: { branch: 'main' } }))
      .toEqual([{ kind: 'read_path', path: '.' }, { kind: 'write_path', path: origin, host: true }])
    const remote = workRepository({ origin: 'https://github.com/5straps/demo.git' })
    expect(effectsOf({ repository: remote, tool: 'git_push', args: { branch: 'main' } }))
      .toEqual([{ kind: 'read_path', path: '.' }, { kind: 'network', url: 'https://github.com' }])
  })

  it('injects the credential through git\'s environment, scoped to the origin, and never as an argument', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    const calls: ProcessRequest[] = []
    const output = await call({
      repository, tool: 'git_push', args: { branch: 'forge-live-check', setUpstream: true },
      runner: scriptedGit(calls, `${apiUrl}/5straps/demo.git`),
    }) as JsonObject
    const push = calls.find(request => request.args[0] === 'push')
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
    expect(push?.args).toEqual(['push', '--receive-pack=git-receive-pack', `${apiUrl}/5straps/demo.git`, 'refs/heads/forge-live-check:refs/heads/forge-live-check'])
    expect(gitConfigOf(push?.environment)[`http.${apiUrl}/5straps/demo.git.extraheader`]).toBe(`Authorization: Basic ${encoded}`)
    expect(gitConfigOf(push?.environment)[`http.${apiUrl}/5straps/demo.git.proxy`]).toBe('')
    expect(gitConfigOf(push?.environment)[`http.${apiUrl}/5straps/demo.git.sslVerify`]).toBe('true')
    expect(gitConfigOf(push?.environment)['http.extraheader']).toBeUndefined()
    expect(JSON.stringify(calls.map(request => request.args))).not.toContain(TOKEN)
    for (const form of [TOKEN, encoded]) expect(JSON.stringify(output)).not.toContain(form)
  })

  it('runs every git call with the workspace hooks, proxies, configs and programs out of reach', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    const calls: ProcessRequest[] = []
    await call({ repository, tool: 'git_push', args: { branch: 'forge-live-check' }, runner: scriptedGit(calls, `${apiUrl}/5straps/demo.git`) })
    for (const request of calls) {
      expect(request.environment.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(request.environment.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(request.environment.GIT_TERMINAL_PROMPT).toBe('0')
      for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        expect(request.environment[name]).toBe('')
      }
      const config = gitConfigOf(request.environment)
      expect(config['core.hooksPath']).toMatch(/git-hooks$/)
      expect(readdirSync(String(config['core.hooksPath']))).toEqual([])
      expect(config).toMatchObject({
        'credential.helper': '',
        'core.fsmonitor': 'false',
        'http.proxy': '',
        'https.proxy': '',
        'remote.origin.proxy': '',
        'http.sslVerify': 'true',
        'core.askpass': '',
        'commit.gpgSign': 'false',
        'tag.gpgSign': 'false',
        'gpg.program': '',
        'gpg.format': '',
        'core.editor': 'true',
        'sequence.editor': 'true',
        'core.pager': 'cat',
        'diff.external': '',
        'core.attributesFile': '/dev/null',
      })
    }
  })

  it('pushes to the real origin when the repository configures a proxy and turns TLS checking off', async () => {
    const origin = await recordingOrigin()
    const proxy = await recordingProxy()
    try {
      const repository = workRepository({ origin: `${origin.url}/5straps/demo.git` })
      git(repository, 'config', 'http.proxy', proxy.url)
      git(repository, 'config', `http.${origin.url}/5straps/demo.git.proxy`, proxy.url)
      git(repository, 'config', 'http.sslVerify', 'false')
      writeFileSync(join(repository, 'kept.txt'), 'kept\n')
      await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })

      // The recording origin is not a git server, so the push fails there — at the right host.
      await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } })).rejects.toThrow()
      expect(proxy.connections()).toBe(0)
      expect(origin.paths).toContain('/5straps/demo.git/info/refs?service=git-receive-pack')
    } finally { origin.close(); proxy.close() }
  }, 30_000)

  it('never runs a receive-pack program the repository configured', async () => {
    const { origin, repository } = bareOrigin()
    const marker = join(repository, 'receivepack-ran.txt')
    writeFileSync(join(repository, 'receivepack.sh'), `#!/bin/sh\ntouch ${marker}\nexec git-receive-pack "$@"\n`, { mode: 0o755 })
    git(repository, 'config', 'remote.origin.receivepack', join(repository, 'receivepack.sh'))
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })

    const output = await call({ repository, tool: 'git_push', args: { branch: 'main', setUpstream: true } }) as JsonObject
    expect(existsSync(marker)).toBe(false)
    expect(execFileSync('git', ['-C', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(output.headSha)
  })

  it('refuses force by name rather than asking about it', async () => {
    const { repository } = bareOrigin()
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main', force: true } }))
      .rejects.toThrow(/refuses force: true by name/)
  })

  it('refuses a remote that is not the forge host and that the owner never approved', async () => {
    const repository = workRepository({ origin: 'https://gitlab.example.com/5straps/demo.git' })
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' }, runner: scriptedGit([], 'https://gitlab.example.com/5straps/demo.git') }))
      .rejects.toThrow(/the configured forge host is/)
  })

  it('allows an approved host, and still withholds the credential from it', async () => {
    const repository = workRepository({ origin: 'https://gitlab.example.com/5straps/demo.git' })
    const calls: ProcessRequest[] = []
    await call({
      repository, tool: 'git_push', args: { branch: 'main' }, approved: ['gitlab.example.com'],
      runner: scriptedGit(calls, 'https://gitlab.example.com/5straps/demo.git'),
    })
    const push = calls.find(request => request.args[0] === 'push')
    expect(Object.keys(gitConfigOf(push?.environment)).filter(key => key.endsWith('.extraheader'))).toEqual([])
    expect(JSON.stringify(push?.environment)).not.toContain(TOKEN)
  })

  // Slice 7b review RG-2: the guard's refusal was read out of every push's stderr, so an https remote's own pre-receive
  // that printed Buckle's prefix turned its failure into PERMISSION_DENIED and a denial in the action log.
  it('reads no refusal out of an https remote\'s stderr: that failed push is GIT_FAILED, an error and not a denial', async () => {
    const url = 'https://gitlab.example.com/5straps/demo.git'
    const repository = workRepository({ origin: url })
    const scripted = scriptedGit([], url)
    const runner: typeof runProcess = async request => request.args[0] === 'push'
      ? { exitCode: 1, signal: null, stdout: '', stderr: 'remote: Buckle refused the push in the receiving git: this is the remote talking\n', truncated: false, timedOut: false }
      : await scripted(request)
    const failed = await call({ repository, tool: 'git_push', args: { branch: 'main' }, approved: ['gitlab.example.com'], runner }).then(() => null, (error: unknown) => error as Error & { code?: string })
    expect(failed?.code).toBe('GIT_FAILED')
  })

  // Slice 7c review RGC-1: the guard's nonce is for the receiving git Buckle runs; an https remote is never handed it.
  it('hands an https push no guard environment, so no nonce reaches the remote', async () => {
    const url = 'https://gitlab.example.com/5straps/demo.git'
    const repository = workRepository({ origin: url })
    const calls: ProcessRequest[] = []
    await call({ repository, tool: 'git_push', args: { branch: 'main' }, approved: ['gitlab.example.com'], runner: scriptedGit(calls, url) })
    const push = calls.find(request => request.args[0] === 'push')!
    expect(Object.keys(push.environment ?? {}).filter(key => key.startsWith('BUCKLE_RECEIVE_'))).toEqual([])
    expect(push.args).toContain('--receive-pack=git-receive-pack')
  })

  it('refuses a push whose real remote is not the one the rules judged', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' }, runner: scriptedGit([], 'https://elsewhere.example.com/5straps/demo.git') }))
      .rejects.toThrow(/not the .* the permission rules judged/)
  })

  it('refuses a branch name that could be read as a flag', async () => {
    const { repository } = bareOrigin()
    await expect(call({ repository, tool: 'git_push', args: { branch: '--force' } })).rejects.toThrow(/Not a usable branch name/)
  })

  it('never runs a workspace hook, on the commit or on the push', async () => {
    const { origin, repository } = bareOrigin()
    const marker = join(repository, 'hook-ran.txt')
    for (const hook of ['pre-commit', 'pre-push']) {
      writeFileSync(join(repository, '.git', 'hooks', hook), `#!/bin/sh\nprintenv > ${marker}\n`, { mode: 0o755 })
    }
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')

    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })
    const output = await call({ repository, tool: 'git_push', args: { branch: 'main', setUpstream: true } }) as JsonObject
    expect(existsSync(marker)).toBe(false)
    expect(execFileSync('git', ['-C', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(output.headSha)
  })

  it('refuses a second push URL by name, because git pushes to every one of them', async () => {
    const { origin, repository } = bareOrigin()
    const second = join(temporaryRoot('second'), 'other.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', second])
    git(repository, 'config', '--add', 'remote.origin.pushurl', origin)
    git(repository, 'config', '--add', 'remote.origin.pushurl', second)
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })

    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } }))
      .rejects.toThrow(/2 remote\.origin\.pushurl values/)
    expect(() => execFileSync('git', ['-C', second, 'rev-parse', 'main'], { stdio: 'pipe' })).toThrow()
  })

  it('refuses a push an insteadOf rule rewrote to another repository on the same host', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    git(repository, 'config', `url.${apiUrl}/attacker/demo.git.pushInsteadOf`, `${apiUrl}/5straps/demo.git`)
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } }))
      .rejects.toThrow(/insteadOf or pushInsteadOf rule rewrites origin/)
  })

  it('refuses a push URL naming another repository on the forge host', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    git(repository, 'config', 'remote.origin.pushurl', `${apiUrl}/attacker/demo.git`)
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } }))
      .rejects.toThrow(/not the .* the permission rules judged/)
  })

  it('refuses a repository whose config includes another file, before any git call', () => {
    const { repository } = bareOrigin()
    appendFileSync(join(repository, '.git', 'config'), '[include]\n\tpath = ../included-config\n')
    expect(() => effectsOf({ repository, tool: 'git_push', args: { branch: 'main' } })).toThrow(/includes another file/)
  })
})

// GPT review of c71dee5, git destination binding (P1): the push destination was read again after the approval
// and the push went to the symbolic origin, so a config changed during the wait sent it somewhere unjudged.
describe('git_push goes to the destination its permission check judged, or nowhere', () => {
  /** Prepared (judged) now, run later: what the invoker does around an approval wait. */
  function prepared(input: { repository: string; runner?: typeof runProcess; approved?: string[] }) {
    const tool = pack(input).tools.find(candidate => candidate.capability.name === 'git_push')!
    const call = tool.prepare({ branch: 'main', setUpstream: true })
    return { effects: call.effects, run: (context: Partial<ToolContext> = {}) => call.execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 20_000, signal: AbortSignal.timeout(20_000), ...context }) }
  }
  function committed(repository: string) {
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    git(repository, 'add', 'kept.txt')
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-m', 'first')
  }
  const hasMain = (bare: string) => { try { execFileSync('git', ['-C', bare, 'rev-parse', '--verify', 'main'], { stdio: 'pipe' }); return true } catch { return false } }
  function other(): string {
    const bare = join(temporaryRoot('other'), 'other.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare])
    return bare
  }

  it('refuses when origin is moved to another local repository while the call waits, and pushes nowhere', async () => {
    const { origin, repository } = bareOrigin()
    committed(repository)
    const push = prepared({ repository })
    expect(push.effects).toEqual([{ kind: 'read_path', path: '.' }, { kind: 'write_path', path: origin, host: true }])
    const moved = other()
    git(repository, 'remote', 'set-url', 'origin', moved)
    await expect(push.run()).rejects.toThrow(`origin resolves to ${moved}, not the ${origin} the permission rules judged`)
    expect([hasMain(origin), hasMain(moved)]).toEqual([false, false])
  })

  it('pushes to the judged repository when origin is moved immediately before git runs, and sets origin\'s refs', async () => {
    const { origin, repository } = bareOrigin()
    committed(repository)
    const moved = other()
    const calls: ProcessRequest[] = []
    const push = prepared({ repository, runner: async (request) => {
      calls.push(request)
      if (request.args[0] === 'push') git(repository, 'remote', 'set-url', 'origin', moved)
      return await runProcess(request)
    } })
    const output = await push.run() as JsonObject
    expect(calls.find(request => request.args[0] === 'push')?.args).toContain(origin)
    expect([hasMain(origin), hasMain(moved)]).toEqual([true, false])
    expect(output).toMatchObject({ remote: origin, headSha: git(origin, 'rev-parse', 'main').trim() })
    expect(git(repository, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(output.headSha)
    expect(git(repository, 'config', 'branch.main.remote').trim()).toBe('origin')
  })

  it.each<[string, (repository: string, moved: string) => void, RegExp]>([
    ['a pushurl added', (repository, moved) => git(repository, 'config', 'remote.origin.pushurl', moved), /not the .* the permission rules judged/],
    ['a pushInsteadOf rule added', (repository, moved) => git(repository, 'config', `url.${moved}.pushInsteadOf`, git(repository, 'config', 'remote.origin.url').trim()), /insteadOf or pushInsteadOf rule rewrites origin/],
    ['an insteadOf rule added', (repository, moved) => git(repository, 'config', `url.${moved}.insteadOf`, git(repository, 'config', 'remote.origin.url').trim()), /insteadOf or pushInsteadOf rule rewrites origin|not the .* the permission rules judged/],
  ])('refuses %s during the wait on a local origin', async (_, change, refusal) => {
    const { origin, repository } = bareOrigin()
    committed(repository)
    const push = prepared({ repository })
    const moved = other()
    change(repository, moved)
    await expect(push.run()).rejects.toThrow(refusal)
    expect([hasMain(origin), hasMain(moved)]).toEqual([false, false])
  })

  it('refuses when an https origin is moved to another repository on the forge host while the call waits', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    const calls: ProcessRequest[] = []
    const push = prepared({ repository, runner: scriptedGit(calls, `${apiUrl}/attacker/demo.git`) })
    expect(push.effects).toEqual([{ kind: 'read_path', path: '.' }, { kind: 'network', url: apiUrl }])
    git(repository, 'remote', 'set-url', 'origin', `${apiUrl}/attacker/demo.git`)
    await expect(push.run()).rejects.toThrow(/not the .*5straps\/demo\.git the permission rules judged/)
    expect(calls.some(request => request.args[0] === 'push')).toBe(false)
  })

  it('judges and pushes a local origin named through a link by its real path, and refuses one the check did not judge as a write', async () => {
    const { origin, repository } = bareOrigin()
    committed(repository)
    const link = join(temporaryRoot('link'), 'origin-link.git')
    symlinkSync(origin, link)
    git(repository, 'remote', 'set-url', 'origin', link)
    const push = prepared({ repository })
    expect(push.effects).toEqual([{ kind: 'read_path', path: '.' }, { kind: 'write_path', path: origin, host: true }])
    await expect(push.run({ authorizeWrite: () => false })).rejects.toThrow(/did not judge as a write/)
    expect(hasMain(origin)).toBe(false)
    expect(await push.run({ authorizeWrite: target => target === origin })).toMatchObject({ remote: origin })
    expect(hasMain(origin)).toBe(true)
  })
})

// Review H3: git reads a push argument as a remote name before it reads it as a URL, and applies every
// insteadOf and pushInsteadOf rule matching it, so a remote named by the judged URL redirected every push, and
// a rule written after the launch check still applied. The launch checks now read every remote name and rule
// git reads, against the exact destination git is handed, and git_push runs under the workspace's write lock.
describe('git_push is sent where no remote name or rewrite rule redirects it (review H3)', () => {
  const servers: GitHttpServer[] = []
  afterEach(async () => {
    spawnHook.beforePush = null
    for (const started of servers.splice(0)) await started.close()
  })

  /** A repository served over git's smart HTTP, a work repository whose origin it is, and a bare repository elsewhere. */
  async function served(): Promise<{ server: GitHttpServer; judged: string; origin: string; repository: string; other: string }> {
    const root = temporaryRoot('served')
    const judged = join(root, 'repos', 'team', 'demo.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', judged])
    const server = await startGitHttp({ projectRoot: join(root, 'repos') })
    servers.push(server)
    const origin = `${server.url}/team/demo.git`
    const repository = workRepository({ origin })
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    git(repository, 'add', 'kept.txt')
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'first')
    const other = join(root, 'other.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', other])
    return { server, judged, origin, repository, other }
  }
  const hasMain = (bare: string) => { try { execFileSync('git', ['-C', bare, 'rev-parse', '--verify', 'main'], { stdio: 'pipe' }); return true } catch { return false } }

  it('refuses a push while a remote is named by the judged URL, and pushes nowhere', async () => {
    const { server, judged, origin, repository, other } = await served()
    git(repository, 'config', `remote.${origin}.url`, other)
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' }, approved: [new URL(server.url).host] }))
      .rejects.toThrow(/names a remote .*which is shaped like a URL or names the push destination/)
    expect([hasMain(judged), hasMain(other)]).toEqual([false, false])
  })

  // Review L8 of the slice 5 re-review: any slash-named remote refused every push, though git applies a remote
  // only when its name is the push argument itself.
  it('pushes while an unrelated slash-named remote such as team/fork is configured', async () => {
    const { origin, repository } = bareOrigin()
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    const fork = join(temporaryRoot('fork'), 'fork.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', fork])
    git(repository, 'remote', 'add', 'team/fork', fork)
    const output = await call({ repository, tool: 'git_push', args: { branch: 'main' } }) as JsonObject
    expect(output).toMatchObject({ remote: origin, headSha: git(origin, 'rev-parse', 'main').trim() })
    expect(hasMain(fork)).toBe(false)
  })

  it.each<[string, (target: string) => string]>([
    ['the exact push target', target => target],
    ['the push target with .git added', target => `${target}.git`],
    ['the push target with a trailing slash', target => `${target}/`],
  ])('refuses a push while a remote is named by %s, and pushes nowhere', async (_, spelling) => {
    const root = temporaryRoot('named')
    const origin = join(root, 'dest')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin])
    const repository = workRepository({ origin })
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    const other = join(root, 'other.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', other])
    git(repository, 'config', `remote.${spelling(origin)}.url`, other)
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } })).rejects.toThrow(/names a remote .*names the push destination/)
    expect([hasMain(origin), hasMain(other)]).toEqual([false, false])
  })

  it('refuses a rewrite rule matching the path git is handed, though origin as written is a link it never matches', async () => {
    const { origin, repository } = bareOrigin()
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    const link = join(temporaryRoot('link'), 'origin-link.git')
    symlinkSync(origin, link)
    git(repository, 'remote', 'set-url', 'origin', link)
    const other = join(temporaryRoot('other'), 'other.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', other])
    git(repository, 'config', `url.${other}.pushInsteadOf`, origin)
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } })).rejects.toThrow(/insteadOf or pushInsteadOf rule rewrites/)
    expect([hasMain(origin), hasMain(other)]).toEqual([false, false])
  })

  it('holds every write in the workspace while it runs, so a rule written between the check and the spawn waits and redirects nothing', async () => {
    const { server, judged, origin, repository, other } = await served()
    const state = join(temporaryRoot('lock-state'), 'state')
    const config = loadConfig({
      BUCKLE_WORKSPACE_ROOT: repository, BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_FORGE_GITHUB_TOKEN: TOKEN, BUCKLE_FORGE_GITHUB_API_URL: apiUrl,
      BUCKLE_NETWORK_ALLOW: new URL(server.url).host,
    })
    const runtime = await createRuntime({ config })
    // The session may write .git, as a person who approved a write there once for the session allows.
    await runtime.grants.grant({ sessionId: 'forge-session', rule: 'write_scope', subject: realpathSync(join(repository, '.git')), scope: 'session' })
    const configPath = join(repository, '.git', 'config')
    const rewritten = `${readFileSync(configPath, 'utf8')}[url "${other}"]\n\tpushInsteadOf = ${origin}\n`
    let writing: Promise<unknown> | null = null
    let landedBeforeSpawn: boolean | null = null
    spawnHook.beforePush = async () => {
      spawnHook.beforePush = null
      // An agent call writing the rule after the launch checks passed: it must wait for the push.
      writing = runtime.invoke({ sessionId: 'forge-session', request: { requestId: 'rewrite', tool: 'fs_write', args: { path: '.git/config', content: rewritten }, approvalTokens: [] } })
      landedBeforeSpawn = await Promise.race([writing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 600))])
    }
    const pushed = await runtime.invoke({ sessionId: 'forge-session', request: { requestId: 'push-1', tool: 'git_push', args: { branch: 'main' }, approvalTokens: [] } })
    expect(pushed).toMatchObject({ outcome: 'ok', output: { remote: origin } })
    expect(landedBeforeSpawn).toBe(false)
    expect([hasMain(judged), hasMain(other)]).toEqual([true, false])
    expect(await writing).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(configPath, 'utf8')).toContain('pushInsteadOf')
    // Present at the next check, the rule is refused there.
    expect(await runtime.invoke({ sessionId: 'forge-session', request: { requestId: 'push-2', tool: 'git_push', args: { branch: 'main' }, approvalTokens: [] } }))
      .toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringMatching(/insteadOf or pushInsteadOf rule rewrites/) } })
    expect(hasMain(other)).toBe(false)
    await runtime.approvalService.close()
    await runtime.history.close()
  })
})

// Review H1 of the slice 5 re-review: git starts the receiving git of a local push in the destination with the
// isolation's GIT_CONFIG_COUNT removed, so the destination's own hooks and program keys ran on the host. The
// receiving git now gets the isolation on its own command line.
describe('a push to a repository on this filesystem isolates the receiving git too (review H1 of the slice 5 re-review)', () => {
  const RECEIVE_HOOKS = ['pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction', 'pre-auto-gc']

  it('lands, and runs none of the destination\'s hooks, its core.alternateRefsCommand or a gc', async () => {
    const { origin, repository } = bareOrigin()
    const markers = temporaryRoot('receiving-markers')
    for (const hook of RECEIVE_HOOKS) writeFileSync(join(origin, 'hooks', hook), `#!/bin/sh\ntouch ${join(markers, hook)}\n`, { mode: 0o755 })
    // An alternate object store, so receive-pack asks core.alternateRefsCommand for its refs.
    const alternate = join(temporaryRoot('alternate'), 'alternate.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', alternate])
    writeFileSync(join(origin, 'objects', 'info', 'alternates'), `${join(alternate, 'objects')}\n`)
    git(origin, 'config', 'core.alternateRefsCommand', `touch ${join(markers, 'alternate-refs')}; true`)
    // Enough loose objects that receive-pack's gc --auto would start, in the foreground.
    git(origin, 'config', 'gc.auto', '1')
    git(origin, 'config', 'gc.autoDetach', 'false')
    mkdirSync(join(origin, 'objects', '17'))
    for (const name of ['a'.repeat(38), 'b'.repeat(38)]) writeFileSync(join(origin, 'objects', '17', name), '')
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })

    const calls: ProcessRequest[] = []
    const output = await call({ repository, tool: 'git_push', args: { branch: 'main' }, runner: async (request) => { calls.push(request); return await runProcess(request) } }) as JsonObject
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(output.headSha)
    expect(readdirSync(markers)).toEqual([])
    const receivePack = calls.find(request => request.args[0] === 'push')?.args.find(word => word.startsWith('--receive-pack='))
    expect(receivePack).toMatch(/'core\.hooksPath=[^']*git-hooks'/)
    expect(receivePack).toContain("'core.alternateRefsCommand=true'")
    // Review L8 of the continuation review: the hooks above are silenced by hooksPath whatever gc does, so the gc
    // keys are asserted on the command line and by their effect: a gc would leave a pack in objects/pack.
    expect(receivePack).toContain("'receive.autogc=false'")
    expect(receivePack).toContain("'gc.auto=0'")
    expect(readdirSync(join(origin, 'objects', 'pack')).filter(name => name.endsWith('.pack'))).toEqual([])
  })

  it('refuses a push to the destination\'s checked-out branch rather than checking it out through its filters', async () => {
    const { repository } = bareOrigin()
    const destination = join(temporaryRoot('checked-out'), 'destination')
    execFileSync('git', ['init', '-q', '-b', 'main', destination])
    git(destination, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'base')
    const marker = join(temporaryRoot('smudge-marker'), 'smudged')
    git(destination, 'config', 'receive.denyCurrentBranch', 'updateInstead')
    git(destination, 'config', 'filter.pwn.smudge', `sh -c 'touch ${marker}; cat'`)
    writeFileSync(join(destination, '.git', 'info', 'attributes'), '* filter=pwn\n')
    git(repository, 'remote', 'set-url', 'origin', destination)
    git(repository, 'fetch', '-q', 'origin', 'main')
    git(repository, 'reset', '-q', '--hard', 'FETCH_HEAD')
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    git(repository, 'add', 'kept.txt')
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'second')

    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' } })).rejects.toThrow(/refusing to update checked out branch|denyCurrentBranch/)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(destination, 'kept.txt'))).toBe(false)
  })
})

// Review H1 of the continuation review: receive-pack follows a destination's `.git` file, `.git` link or `commondir`
// into a repository nothing judged, so a push judged as a write on `dest` landed refs in another repository with no
// ask; git_commit judged its repository the same way. The git directory is now read from the disk before any git
// runs there, and confirmed with git itself.
describe('a local push or a commit writes only the repository its permission check judged (review H1 of the continuation review)', () => {
  /** A work repository with one commit whose origin is `dest`, shaped by `shape`, beside a victim repository. */
  function redirected(shape: (destination: string, victim: string) => void) {
    const root = temporaryRoot('redirect')
    const victim = join(root, 'victim.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', victim])
    const destination = join(root, 'dest')
    mkdirSync(destination)
    shape(destination, victim)
    const repository = workRepository({ origin: destination })
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    return { victim, destination, repository, before: filesUnder(victim) }
  }
  const recording = (calls: ProcessRequest[]): typeof runProcess => async (request) => {
    calls.push(request)
    return await runProcess(request)
  }
  const bareShaped = (destination: string) => {
    writeFileSync(join(destination, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(destination, 'objects'))
    mkdirSync(join(destination, 'refs'))
  }
  const bareWithLink = (name: string) => (destination: string, victim: string) => {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination])
    rmSync(join(destination, name), { recursive: true, force: true })
    symlinkSync(join(victim, name), join(destination, name))
  }

  it.each<[string, (destination: string, victim: string) => void]>([
    ['a .git file naming another repository', (destination, victim) => writeFileSync(join(destination, '.git'), `gitdir: ${victim}\n`)],
    ['a .git symbolic link', (destination, victim) => symlinkSync(victim, join(destination, '.git'))],
    ['a commondir file in a bare-shaped destination', (destination, victim) => {
      bareShaped(destination)
      writeFileSync(join(destination, 'commondir'), `${victim}\n`)
    }],
    ['a commondir file in its .git directory', (destination, victim) => {
      mkdirSync(join(destination, '.git'))
      bareShaped(join(destination, '.git'))
      writeFileSync(join(destination, '.git', 'commondir'), `${victim}\n`)
    }],
    ['an objects symbolic link', bareWithLink('objects')],
    ['a HEAD symbolic link', bareWithLink('HEAD')],
    ['a refs/heads symbolic link', (destination, victim) => {
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination])
      rmSync(join(destination, 'refs', 'heads'), { recursive: true, force: true })
      symlinkSync(join(victim, 'refs', 'heads'), join(destination, 'refs', 'heads'))
    }],
  ])('refuses a destination with %s before any git runs in it, and the other repository is untouched', async (_, shape) => {
    const { victim, destination, repository, before } = redirected(shape)
    const calls: ProcessRequest[] = []
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' }, runner: recording(calls) }))
      .rejects.toThrow(new RegExp(`^${destination.replaceAll('/', '\\/')}.*permission rules never judged; push to the real repository by its own path`))
    expect(calls.filter(request => request.args[0] === 'push' || request.cwd?.startsWith(destination))).toEqual([])
    expect(filesUnder(victim)).toEqual(before)
  })

  // Slice 7 review F3: the checks above hold only the pushing workspace's lock, so a write from another workspace
  // could plant a pointer after them (1 of 40 races landed in the repository it named). A test hook plants it right
  // before git push starts; the receiving git's guard tests the repository it really opened and refuses.
  const REFUSED = /so git would write somewhere the permission rules never judged; push to the real repository by its own path \(set origin to it\)/
  it.each<[string, (destination: string, victim: string) => void, RegExp]>([
    ['a .git file naming another repository', (destination, victim) => writeFileSync(join(destination, '.git'), `gitdir: ${victim}\n`), /^receive-pack opened \/.*\/victim\.git, not the git directory \/.*\/dest checked before the push/],
    ['a .git symbolic link', (destination, victim) => symlinkSync(victim, join(destination, '.git')), /^receive-pack opened \/.*\/victim\.git, not the git directory/],
    ['a commondir file', (destination, victim) => writeFileSync(join(destination, 'commondir'), `${victim}\n`), /^receive-pack stores the pushed objects in \/.*\/victim\.git\/(\.\/)?objects, outside \/.*\/dest/],
    ['a refs/heads symbolic link', (destination, victim) => {
      rmSync(join(destination, 'refs', 'heads'), { recursive: true, force: true })
      symlinkSync(join(victim, 'refs', 'heads'), join(destination, 'refs', 'heads'))
    }, /^\/.*\/dest\/refs\/heads is a symbolic link/],
    ['a .git directory that is not the one checked', (destination) => {
      mkdirSync(join(destination, '.git'))
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', join(destination, '.git')])
    }, /^receive-pack opened \/.*\/dest\/\.git, not the git directory \/.*\/dest checked/],
  ])('refuses %s planted after the checks, in the receiving git, and no repository gets the ref', async (_, plant, reason) => {
    const { victim, destination, repository, before } = redirected(destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination]))
    spawnHook.beforePush = async () => {
      spawnHook.beforePush = null
      plant(destination, victim)
    }
    const refused = await call({ repository, tool: 'git_push', args: { branch: 'main' } }).then(() => null, (error: unknown) => error as Error & { code?: string })
    expect(refused?.code).toBe('PERMISSION_DENIED')
    expect(refused?.message).toMatch(reason)
    expect(refused?.message).toMatch(REFUSED)
    expect(filesUnder(victim)).toEqual(before)
    expect(execFileSync('git', ['--git-dir', destination, 'for-each-ref'], { encoding: 'utf8' }).trim()).toBe('')
    expect(existsSync(join(destination, 'refs', 'heads', 'main'))).toBe(false)
  })

  it('refuses a destination git no longer reads as a repository by the time it receives, rather than the <dest>.git beside it', async () => {
    const { destination, repository } = redirected(destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination]))
    const beside = `${destination}.git`
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', beside])
    const before = filesUnder(beside)
    spawnHook.beforePush = async () => {
      spawnHook.beforePush = null
      rmSync(join(destination, 'HEAD'))
    }
    const refused = await call({ repository, tool: 'git_push', args: { branch: 'main' } }).then(() => null, (error: unknown) => error as Error & { code?: string })
    expect(refused?.code).toBe('PERMISSION_DENIED')
    expect(refused?.message).toMatch(/^receive-pack opened \/.*\/dest\.git, not the git directory \/.*\/dest checked/)
    expect(git(beside, 'for-each-ref').trim()).toBe('')
    expect(filesUnder(beside)).toEqual(before)
  })

  it('writes Buckle\'s guard as the receiving git\'s only hook, run by this node', async () => {
    const { destination, repository } = redirected(destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination]))
    const calls: ProcessRequest[] = []
    await call({ repository, tool: 'git_push', args: { branch: 'main' }, runner: recording(calls) })
    const push = calls.find(request => request.args[0] === 'push')!
    const hooks = push.args.find(word => word.startsWith('--receive-pack='))?.match(/'core\.hooksPath=([^']*)'/)?.[1] ?? ''
    expect(readdirSync(hooks)).toEqual(['pre-receive'])
    expect(readFileSync(join(hooks, 'pre-receive'), 'utf8')).toMatch(new RegExp(`^#!/bin/sh\\nexec '${process.execPath.replaceAll('/', '\\/')}' -e `))
    expect(push.environment).toMatchObject({ BUCKLE_RECEIVE_REPOSITORY: destination, BUCKLE_RECEIVE_GIT_DIRECTORY: destination })
    expect(push.environment?.BUCKLE_RECEIVE_NONCE).toMatch(/^[0-9a-f]{32}$/)
  })

  // Slice 7c review RGC-1: the receiving git quotes a config value it cannot parse, so a destination whose
  // receive.denyDeletes held the refusal's prefix turned its own failed push into PERMISSION_DENIED with a reason it chose.
  it.each<[string, string]>([
    ['the refusal\'s prefix', 'Buckle refused the push in the receiving git: the owner denied this push'],
    ['the refusal\'s prefix with a guessed nonce', `Buckle refused the push in the receiving git (push ${'0'.repeat(32)}): the owner denied this push`],
  ])('reads a destination config value holding %s as a failed push, GIT_FAILED and not a refusal', async (_, text) => {
    const { destination, repository } = redirected(destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination]))
    git(destination, 'config', 'receive.denyDeletes', text)
    const failed = await call({ repository, tool: 'git_push', args: { branch: 'main' } }).then(() => null, (error: unknown) => error as Error & { code?: string })
    expect(failed?.code).toBe('GIT_FAILED')
    expect(failed?.message).toContain('bad boolean config value')
    expect(git(destination, 'for-each-ref').trim()).toBe('')
  })

  // Slice 7b review RG-1: git skips a pre-receive hook it cannot execute, with a hint and exit 0, so a guard restored
  // without its execute bit let a `.git` pointer planted after the checks land the ref in the repository it named.
  it('makes a guard restored without its execute bit executable again, and it refuses a pointer planted after the checks', async () => {
    const { victim, destination, repository, before } = redirected(destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination]))
    const state = temporaryRoot('state')
    guardedReceivePackCommand(state)
    const hook = join(state, 'receive-git-hooks', 'pre-receive')
    chmodSync(hook, 0o600)
    let mode = 0
    spawnHook.beforePush = async () => {
      spawnHook.beforePush = null
      mode = statSync(hook).mode & 0o777
      writeFileSync(join(destination, '.git'), `gitdir: ${victim}\n`)
    }
    const refused = await call({ repository, tool: 'git_push', args: { branch: 'main' }, stateDirectory: state }).then(() => null, (error: unknown) => error as Error & { code?: string })
    expect(mode).toBe(0o700)
    expect(refused?.code).toBe('PERMISSION_DENIED')
    expect(refused?.message).toMatch(/^receive-pack opened \/.*\/victim\.git, not the git directory \/.*\/dest checked before the push/)
    expect(filesUnder(victim)).toEqual(before)
  })

  // Slice 7c review RGC-2: the refusal was written with echo, which dash (/bin/sh here) reads backslash escapes in, so a
  // state path holding `\n` or `\c` broke or cut the reason. Buckle now names paths with pathe, which reads those
  // backslashes as separators, so the path joins here with pathe too.
  it.each<[string, (root: string) => string]>([
    ['', root => root],
    [', its state path holding backslashes', root => join(root, 's\\ntate\\cEND')],
  ])('refuses in the receiving command when the guard loses its execute bit after the checks%s, and leaves no ref, quarantine or lock', async (_, stateOf) => {
    const { victim, destination, repository, before } = redirected(destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination]))
    const state = stateOf(temporaryRoot('state'))
    const untouched = filesUnder(destination)
    spawnHook.beforePush = async () => {
      spawnHook.beforePush = null
      chmodSync(join(state, 'receive-git-hooks', 'pre-receive'), 0o600)
      writeFileSync(join(destination, '.git'), `gitdir: ${victim}\n`)
    }
    const refused = await call({ repository, tool: 'git_push', args: { branch: 'main' }, stateDirectory: state }).then(() => null, (error: unknown) => error as Error & { code?: string })
    expect(refused?.code).toBe('PERMISSION_DENIED')
    expect(refused?.message).toBe(`its guard ${join(state, 'receive-git-hooks', 'pre-receive')} cannot be run, so git would skip it and could write somewhere the permission rules never judged; restore the file's execute permission, or keep Buckle's state directory off a noexec mount`)
    expect(filesUnder(victim)).toEqual(before)
    expect(filesUnder(destination).filter(path => path !== join(destination, '.git'))).toEqual(untouched)
  })

  it('still pushes a branch to a non-bare repository on this filesystem through the guarded command', async () => {
    const root = temporaryRoot('non-bare')
    const destination = join(root, 'dest')
    execFileSync('git', ['init', '-q', '-b', 'main', destination])
    const repository = workRepository({ origin: destination })
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    git(repository, 'branch', 'feature')
    const output = await call({ repository, tool: 'git_push', args: { branch: 'feature' } }) as JsonObject
    expect(git(destination, 'rev-parse', 'refs/heads/feature').trim()).toBe(output.headSha)
  })

  it('refuses a directory git does not read as a repository, which receive-pack would trade for <dest>.git beside it', async () => {
    const { destination, repository } = redirected(() => undefined)
    const beside = `${destination}.git`
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', beside])
    const calls: ProcessRequest[] = []
    await expect(call({ repository, tool: 'git_push', args: { branch: 'main' }, runner: recording(calls) }))
      .rejects.toThrow(/git does not resolve .* to its own git directory .*push to the real repository by its own path/)
    expect(calls.some(request => request.args[0] === 'push')).toBe(false)
    expect(git(beside, 'for-each-ref').trim()).toBe('')
  })

  it.each<[string, (destination: string) => void]>([
    ['bare', destination => execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination])],
    ['non-bare, on another branch', destination => execFileSync('git', ['init', '-q', '-b', 'trunk', destination])],
  ])('still pushes to a plain %s destination', async (_, shape) => {
    const { destination, repository } = redirected(shape)
    const output = await call({ repository, tool: 'git_push', args: { branch: 'main' } }) as JsonObject
    expect(output).toMatchObject({ branch: 'main', remote: destination })
    expect(git(destination, 'rev-parse', 'refs/heads/main').trim()).toBe(output.headSha)
  })

  it.each<[string, (repository: string, victim: string) => void]>([
    ['a .git file', (repository, victim) => writeFileSync(join(repository, '.git'), `gitdir: ${join(victim, '.git')}\n`)],
    ['a .git symbolic link', (repository, victim) => symlinkSync(join(victim, '.git'), join(repository, '.git'))],
  ])('refuses a commit in a repository whose %s names another one, before any git runs', async (_, shape) => {
    const root = temporaryRoot('commit-redirect')
    const victim = join(root, 'victim')
    execFileSync('git', ['init', '-q', '-b', 'main', victim])
    const repository = join(root, 'work')
    mkdirSync(repository)
    shape(repository, victim)
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    const before = filesUnder(join(victim, '.git'))
    const calls: ProcessRequest[] = []
    await expect(call({ repository, tool: 'git_commit', args: { message: 'redirected', paths: ['kept.txt'] }, runner: recording(calls) }))
      .rejects.toThrow(/permission rules never judged; commit in the real repository by its own path/)
    expect(calls).toEqual([])
    expect(filesUnder(join(victim, '.git'))).toEqual(before)
  })

  // Slice 7c review RGC-1: through a node, the same push is an error in the response and the action log, not a denial.
  it('answers a push the destination\'s own config text fails with an error outcome, GIT_FAILED, through a node', async () => {
    const root = temporaryRoot('config-text')
    const repository = join(root, 'work')
    execFileSync('git', ['init', '-q', '-b', 'main', repository])
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    const scratch = join(repository, 'scratch')
    const destination = join(scratch, 'dest')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', destination])
    git(destination, 'config', 'receive.denyDeletes', 'Buckle refused the push in the receiving git: the owner denied this push')
    git(repository, 'remote', 'add', 'origin', destination)
    const runtime = await createRuntime({ config: loadConfig({
      BUCKLE_WORKSPACE_ROOT: repository, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_FORGE_GITHUB_TOKEN: TOKEN, BUCKLE_FORGE_GITHUB_API_URL: apiUrl, BUCKLE_SCRATCH_ROOTS: scratch,
    }) })
    try {
      const pushed = await runtime.invoke({ sessionId: 's', request: { requestId: 'push', tool: 'git_push', args: { branch: 'main' }, approvalTokens: [] } })
      expect(pushed).toMatchObject({ outcome: 'error', error: { code: 'GIT_FAILED', message: expect.stringContaining('bad boolean config value') } })
      expect(git(destination, 'for-each-ref').trim()).toBe('')
    } finally {
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  })

  it('refuses, through a node, a gitfile the agent planted in a scratch root, where a write needs no ask', async () => {
    const root = temporaryRoot('scratch-redirect')
    const victim = join(root, 'victim.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', victim])
    const repository = join(root, 'work')
    execFileSync('git', ['init', '-q', '-b', 'main', repository])
    git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'first')
    const scratch = join(repository, 'scratch')
    const destination = join(scratch, 'dest')
    mkdirSync(destination, { recursive: true })
    git(repository, 'remote', 'add', 'origin', destination)
    const runtime = await createRuntime({ config: loadConfig({
      BUCKLE_WORKSPACE_ROOT: repository, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_FORGE_GITHUB_TOKEN: TOKEN, BUCKLE_FORGE_GITHUB_API_URL: apiUrl, BUCKLE_SCRATCH_ROOTS: scratch,
    }) })
    try {
      const planted = await runtime.invoke({ sessionId: 's', request: { requestId: 'plant', tool: 'fs_write', args: { path: join(destination, '.git'), content: `gitdir: ${victim}\n` }, approvalTokens: [] } })
      expect(planted).toMatchObject({ outcome: 'ok' })
      const pushed = await runtime.invoke({ sessionId: 's', request: { requestId: 'push', tool: 'git_push', args: { branch: 'main' }, approvalTokens: [] } })
      expect(pushed).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('push to the real repository by its own path') } })
      expect(git(victim, 'for-each-ref').trim()).toBe('')
    } finally {
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  })
})

/** Every file below `root` with its size, so a write anywhere in it shows up as a difference. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

// Review M4: git is handed the judged URL without its userinfo, and isolation leaves it no helper or prompt, so
// a push to an approved non-forge origin that authenticates with userinfo failed where it worked before.
describe('a push to an approved https origin that names userinfo (review M4)', () => {
  it('sends the userinfo as a Basic header scoped to the judged URL, never on argv, and shows it nowhere', async () => {
    const root = temporaryRoot('userinfo')
    const judged = join(root, 'repos', 'team', 'demo.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', judged])
    const password = 'Pa55-userinfo-5ecret'
    const server = await startGitHttp({ projectRoot: join(root, 'repos'), basic: { user: 'alice', password } })
    try {
      // Named as localhost, so it is not the scripted forge's host (127.0.0.1), whose token would be sent instead.
      const host = server.url.replace('127.0.0.1', 'localhost')
      const display = `${host}/team/demo.git`
      const repository = workRepository({ origin: display.replace('http://', `http://alice:${password}@`) })
      writeFileSync(join(repository, 'kept.txt'), 'kept\n')
      git(repository, 'add', 'kept.txt')
      git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'first')
      const calls: ProcessRequest[] = []
      const output = await call({ repository, tool: 'git_push', args: { branch: 'main' }, approved: [new URL(host).host], runner: async (request) => { calls.push(request); return await runProcess(request) } }) as JsonObject
      expect(output).toMatchObject({ branch: 'main', remote: display, headSha: git(judged, 'rev-parse', 'main').trim() })
      const push = calls.find(request => request.args[0] === 'push')!
      expect(push.args).toContain(display)
      expect(gitConfigOf(push.environment)[`http.${display}.extraheader`]).toBe(`Authorization: Basic ${Buffer.from(`alice:${password}`).toString('base64')}`)
      expect(server.authorizations).toContain(`Basic ${Buffer.from(`alice:${password}`).toString('base64')}`)
      expect(JSON.stringify(output)).not.toContain(password)
      expect(JSON.stringify(calls.map(request => request.args))).not.toContain(password)
      const effects = effectsOf({ repository, tool: 'git_push', args: { branch: 'main' } })
      expect(JSON.stringify(effects)).not.toContain(password)

      // Through a node: the result and the audit log carry no form of it either.
      const state = join(root, 'state')
      const runtime = await createRuntime({ config: loadConfig({
        BUCKLE_WORKSPACE_ROOT: repository, BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true',
        BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_FORGE_GITHUB_TOKEN: TOKEN, BUCKLE_FORGE_GITHUB_API_URL: apiUrl, BUCKLE_NETWORK_ALLOW: new URL(host).host,
      }) })
      git(repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '--allow-empty', '-m', 'second')
      const response = await runtime.invoke({ sessionId: 'forge-session', request: { requestId: 'userinfo-push', tool: 'git_push', args: { branch: 'main' }, approvalTokens: [] } })
      expect(response).toMatchObject({ outcome: 'ok', output: { remote: display, headSha: git(judged, 'rev-parse', 'main').trim() } })
      await runtime.approvalService.close()
      await runtime.history.close()
      const basic = Buffer.from(`alice:${password}`).toString('base64')
      for (const form of [password, basic]) {
        expect(JSON.stringify(response)).not.toContain(form)
        expect(readFileSync(join(state, 'actions.jsonl'), 'utf8')).not.toContain(form)
      }
    } finally { await server.close() }
  })
})

// Review L4: a local destination is a host path, and the agent's view took one under the mount's name for its own.
it('judges a local push destination at its host path under a mount (review L4)', async () => {
  const mount = temporaryRoot('mounted')
  const workspace = join(mount, 'proj')
  mkdirSync(workspace)
  const origin = join(workspace, 'bare.git')
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin])
  const repository = join(workspace, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', repository])
  git(repository, 'remote', 'add', 'origin', origin)
  const paths = createPathView({ root: workspace, mount })
  const tool = pack({ repository, paths }).tools.find(candidate => candidate.capability.name === 'git_push')!
  const effects = await resolveEffects({ effects: tool.prepare({ repo: `${mount}/work`, branch: 'main' }).effects, paths })
  expect(effects).toContainEqual({ kind: 'write_path', path: origin, directory: origin })
  expect(effects).not.toContainEqual(expect.objectContaining({ path: join(workspace, 'proj', 'bare.git') }))
})

/** Answers the git calls a push makes, so the environment can be inspected without a server. */
function scriptedGit(calls: ProcessRequest[], pushUrl: string): typeof runProcess {
  return async (request): Promise<ProcessResult> => {
    calls.push(request)
    const ok = (stdout: string): ProcessResult => ({ exitCode: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false })
    if (request.args[0] === 'config') {
      // Exit 1 is git's answer for a key the config does not hold, and for a pattern nothing matches.
      if (request.args.includes('remote.origin.pushurl') || request.args.includes('--get-regexp')) return { ...ok(''), exitCode: 1 }
      return ok(`${pushUrl}\n`)
    }
    if (request.args[0] === 'remote') return ok(`${pushUrl}\n`)
    if (request.args[0] === 'rev-parse') return ok(`${'c'.repeat(40)}\n`)
    return ok('')
  }
}

/** The `GIT_CONFIG_KEY_n`/`VALUE_n` scope read back as the config git would see. */
function gitConfigOf(environment: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const config: Record<string, string> = {}
  for (let index = 0; index < Number(environment?.GIT_CONFIG_COUNT ?? '0'); index++) {
    config[String(environment?.[`GIT_CONFIG_KEY_${index}`])] = String(environment?.[`GIT_CONFIG_VALUE_${index}`])
  }
  return config
}

describe('pr_open', () => {
  it('opens a pull request under a bearer token, deriving the repository from origin', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })
    git(repository, 'update-ref', 'refs/remotes/origin/forge-live-check', 'HEAD')
    seenAuthorization.length = 0
    const output = await call({ repository, tool: 'pr_open', args: { head: 'forge-live-check', base: 'main', title: 'collapse separators', body: 'see the ticket' } }) as JsonObject
    expect(output).toMatchObject({ number: 7, state: 'open', url: 'https://github.com/5straps/demo/pull/7' })
    expect(seenAuthorization).toEqual([`Bearer ${TOKEN}`])
  })

  it('refuses a head branch that was never pushed', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    writeFileSync(join(repository, 'kept.txt'), 'kept\n')
    await call({ repository, tool: 'git_commit', args: { message: 'first', paths: ['kept.txt'] } })
    await expect(call({ repository, tool: 'pr_open', args: { head: 'forge-live-check', base: 'main', title: 't', body: '' } }))
      .rejects.toThrow(/is not on origin yet/)
  })

  it('declares the forge API as its network effect, so the egress rule judges it', () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    expect(effectsOf({ repository, tool: 'pr_open', args: { head: 'a', base: 'main', title: 't', body: '' } }))
      .toEqual([{ kind: 'read_path', path: '.' }, { kind: 'network', url: apiUrl }])
  })

  it('refuses an origin that is not the configured forge, rather than acting on it under the token', async () => {
    const repository = workRepository({ origin: 'https://gitlab.example.com/attacker/demo.git' })
    await expect(call({ repository, tool: 'pr_open', args: { head: 'forge-live-check', base: 'main', title: 't', body: '' } }))
      .rejects.toThrow(/the pull-request tools act on that forge alone/)
  })
})

describe('pr_read', () => {
  it('returns the pull request, and only the extras that were asked for', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    const plain = await call({ repository, tool: 'pr_read', args: { number: 7 } }) as JsonObject
    expect(plain).toMatchObject({ number: 7, state: 'open', head: { ref: 'forge-live-check' }, base: { ref: 'main' } })
    expect(plain.diff).toBeUndefined()
    expect(plain.files).toBeUndefined()

    const full = await call({ repository, tool: 'pr_read', args: { number: 7, include: ['diff', 'files', 'comments'] } }) as JsonObject
    expect(full.files).toEqual([{ path: 'src/slugify.js', status: 'modified', additions: 3, deletions: 1 }])
    expect(full.comments).toEqual([{ author: '5straps', at: '2026-09-20T00:00:00Z', body: 'looks right' }])
    expect(full.diffTruncated).toBe(true)
    expect(String(full.diff)).toHaveLength(524_288)
  })

  it('strips the credential from every field it returns: title, diff, files and comments', async () => {
    const repository = workRepository({ origin: `${apiUrl}/5straps/demo.git` })
    const full = await call({ repository, tool: 'pr_read', args: { number: 8, include: ['diff', 'files', 'comments'] } }) as JsonObject
    const text = JSON.stringify(full)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(BASIC)
    expect(String(full.title)).toMatch(/^leak /)
    expect(String(full.diff)).toContain('+token=')
    expect((full.files as JsonObject[])[0]?.path).toMatch(/^src\/.+\.js$/)
    expect((full.comments as JsonObject[])[0]?.body).toMatch(/^here is /)
  })

  it('refuses an origin that is not the configured forge', async () => {
    const repository = workRepository({ origin: 'https://gitlab.example.com/attacker/demo.git' })
    await expect(call({ repository, tool: 'pr_read', args: { number: 7 } }))
      .rejects.toThrow(/the pull-request tools act on that forge alone/)
  })
})

describe('the credential', () => {
  it('never reaches a result, an error, or the action log, even when the forge echoes it back', async () => {
    const root = temporaryRoot('node')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    execFileSync('git', ['init', '-b', 'main', workspace])
    git(workspace, 'remote', 'add', 'origin', `${apiUrl}/leaky/repo.git`)
    writeFileSync(join(workspace, 'kept.txt'), 'kept\n')
    git(workspace, 'add', 'kept.txt')
    git(workspace, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-m', 'first')
    git(workspace, 'update-ref', 'refs/remotes/origin/side', 'HEAD')

    const config = loadConfig({
      BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_FORGE_GITHUB_TOKEN: TOKEN, BUCKLE_FORGE_GITHUB_API_URL: apiUrl,
      BUCKLE_NETWORK_ALLOW: new URL(apiUrl).host,
    })
    const runtime = await createRuntime({ config })
    const response = await runtime.invoke({
      request: { requestId: 'leak-check', tool: 'pr_open', args: { head: 'side', base: 'main', title: 't', body: '' }, approvalTokens: [] },
      sessionId: 'forge-session',
    })
    expect(response.outcome).toBe('error')
    if (response.outcome === 'error') {
      expect(response.error.message).toContain('[redacted]')
      expect(response.error.message).not.toContain(TOKEN)
    }
    expect(JSON.stringify(response)).not.toContain(TOKEN)
    expect(readFileSync(join(root, 'state', 'actions.jsonl'), 'utf8')).not.toContain(TOKEN)
  })

  it('stays out of the refusals the push checks write, even when the remote itself carries it', async () => {
    const credentialled = apiUrl.replace('http://', `http://x-access-token:${TOKEN}@`)
    const mismatched = workRepository({ origin: `${credentialled}/5straps/demo.git` })
    git(mismatched, 'config', 'remote.origin.pushurl', `${apiUrl}/attacker/demo.git`)
    const rewritten = workRepository({ origin: `${credentialled}/5straps/demo.git` })
    git(rewritten, 'config', `url.${apiUrl}/attacker/demo.git.pushInsteadOf`, `${credentialled}/5straps/demo.git`)

    for (const repository of [mismatched, rewritten]) {
      const thrown = await call({ repository, tool: 'git_push', args: { branch: 'main' } }).catch((error: Error) => error)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/the permission rules judged|insteadOf or pushInsteadOf rule rewrites origin/)
      for (const form of [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString('base64')]) {
        expect((thrown as Error).message).not.toContain(form)
      }
    }
  })

  it('is refused the network when BUCKLE_NETWORK_ALLOW omits the forge host', async () => {
    const root = temporaryRoot('egress')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    execFileSync('git', ['init', '-b', 'main', workspace])
    git(workspace, 'remote', 'add', 'origin', 'https://github.com/5straps/demo.git')

    const config = loadConfig({
      BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_FORGE_GITHUB_TOKEN: TOKEN, BUCKLE_FORGE_GITHUB_API_URL: apiUrl,
      BUCKLE_NETWORK_ALLOW: 'example.com',
    })
    const runtime = await createRuntime({ config })
    const response = await runtime.invoke({
      request: { requestId: 'egress-check', tool: 'pr_read', args: { number: 7 }, approvalTokens: [] },
      sessionId: 'forge-session',
    })
    expect(response.outcome).toBe('error')
    if (response.outcome === 'error') {
      expect(response.error.code).toBe('PERMISSION_DENIED')
      expect(response.error.message).toContain('approved list')
    }
  })

  it('withholds the whole pack when it is absent, naming the variable in the manifest', async () => {
    const root = temporaryRoot('nocred')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_AUTH_TOKEN: 'agent-token' })
    const runtime = await createRuntime({ config })
    const descriptor = runtime.manifest().packs.find(candidate => candidate.id === 'forge')
    expect(descriptor?.unavailableReason).toContain('BUCKLE_FORGE_GITHUB_TOKEN')
    expect(runtime.manifest().tools.map(tool => tool.name)).not.toContain('pr_open')
    expect(descriptor?.toolNames).toEqual(['git_commit', 'git_push', 'pr_open', 'pr_read'])
  })
})

// Review L5 of the second proof-of-possession re-review: a forge commit approved for one repository landed in
// another when a link was swapped during the approval wait.
describe('a forge tool runs in the repository its permission check judged', () => {
  it.each<[string, JsonObject, 'authorizeWrite' | 'authorizeReadTarget']>([
    ['git_commit', { repo: 'repo', paths: ['a.txt'], message: 'approved change' }, 'authorizeWrite'],
    ['pr_read', { repo: 'repo', number: 7 }, 'authorizeReadTarget'],
  ])('refuses %s when the repository link was swapped after the check, and runs no git', async (name, args, judge) => {
    const root = temporaryRoot('judged')
    for (const directory of ['inside', 'outside']) mkdirSync(join(root, directory))
    symlinkSync('inside', join(root, 'repo'))
    const ran: ProcessRequest[] = []
    const built = pack({ repository: root, runner: async (request) => { ran.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } } })
    const tool = built.tools.find(candidate => candidate.capability.name === name)!
    const prepared = tool.prepare(args)
    unlinkSync(join(root, 'repo'))
    symlinkSync('outside', join(root, 'repo'))
    await expect(prepared.execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), [judge]: (target: string) => target === join(root, 'inside') })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(ran).toEqual([])
  })
})
