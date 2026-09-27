import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createSocketServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../common/adapters/approval/deferred-approval-channel.js'
import { createGitHubForgeClient } from '../common/adapters/forge/github.js'
import { runProcess } from '../common/adapters/process-runner.js'
import { loadConfig } from '../common/runtime/config.js'
import { forgeGitHost } from '../common/domain/forge.js'
import { createPathView } from '../common/domain/path-view.js'
import { compileUrlPatterns } from '../common/domain/url-pattern.js'
import { createForgePack, type ForgePackOptions } from '../common/services/packs/forge/index.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

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

function pack(input: { repository: string; token?: string; runner?: typeof runProcess; approved?: string[] }) {
  const token = input.token ?? TOKEN
  const options: ForgePackOptions = {
    paths: createPathView({ root: input.repository, mount: null }),
    runProcess: input.runner ?? runProcess,
    stateDirectory: temporaryRoot('state'),
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

async function call(input: { repository: string; tool: string; args: JsonObject; token?: string; runner?: typeof runProcess; approved?: string[] }): Promise<JsonValue> {
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
      .toEqual([{ kind: 'read_path', path: '.' }, { kind: 'write_path', path: origin }])
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
    expect(push?.args).toEqual(['push', '--receive-pack=git-receive-pack', '--set-upstream', 'origin', 'forge-live-check'])
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

/** Answers the git calls a push makes, so the environment can be inspected without a server. */
function scriptedGit(calls: ProcessRequest[], pushUrl: string): typeof runProcess {
  return async (request): Promise<ProcessResult> => {
    calls.push(request)
    const ok = (stdout: string): ProcessResult => ({ exitCode: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false })
    if (request.args[0] === 'config') {
      // Exit 1 is git's answer for a key the config does not hold.
      if (request.args.includes('remote.origin.pushurl')) return { ...ok(''), exitCode: 1 }
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
    const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
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
    const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
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
    const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
    const descriptor = runtime.manifest().packs.find(candidate => candidate.id === 'forge')
    expect(descriptor?.unavailableReason).toContain('BUCKLE_FORGE_GITHUB_TOKEN')
    expect(runtime.manifest().tools.map(tool => tool.name)).not.toContain('pr_open')
    expect(descriptor?.toolNames).toEqual(['git_commit', 'git_push', 'pr_open', 'pr_read'])
  })
})
