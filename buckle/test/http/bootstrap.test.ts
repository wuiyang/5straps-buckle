import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLOSE_STAGES } from '@5straps/runtime'
import { generateSigningKey, keyIdOf, publicKeyFrom, readChallenge, signingKeyFromPem, signRequest } from '@5straps/protocol/signed-request'
import { afterAll, describe, expect, inject, it, vi } from 'vitest'
import { firstResponse, freePort, spawnBuckle, waitForStatus, type BuckleProcess, type LogLine } from '../support/buckle-process.js'
import { workspaceIdOf } from '../support/workspaces.js'

// The package as installed: dist/main.js, and .output beside it, found from the package root.
const entry = inject('buckleBuild').main
const running: BuckleProcess[] = []

afterAll(() => {
  for (const node of running) node.child.kill('SIGKILL')
})

interface Node { root: string; workspace: string; state: string; env: NodeJS.ProcessEnv; port: number }

async function prepareNode(extra: NodeJS.ProcessEnv = {}): Promise<Node> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-bootstrap-'))
  const workspace = join(root, 'workspace')
  const state = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, TMPDIR: root,
    // The state directory's own file, which is not there: a node set up by its environment alone, as buckle mcp reads one too.
    BUCKLE_ENV_FILE: join(state, 'buckle.env'), BUCKLE_HOST: '127.0.0.1', BUCKLE_PORT: String(port),
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_AUTH_TOKEN: 'bootstrap-agent-token',
    BUCKLE_ALLOW_SHELL: 'false', ...extra,
  }
  return { root, workspace, state, env, port }
}

// A plugin whose pack waits for a file: the test decides when startup ends, and counts how often it was built.
function installGatePlugin(node: Node): { gate: string; builds: string } {
  const gate = join(node.root, 'startup-gate')
  const builds = join(node.root, 'pack-builds')
  const plugin = join(node.root, 'gate-plugin.mjs')
  writeFileSync(plugin, `import { appendFileSync, existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
export async function createPack() {
  appendFileSync(${JSON.stringify(builds)}, 'x')
  while (!existsSync(${JSON.stringify(gate)})) await delay(20)
  return { id: 'gate', version: '1.0.0', tools: [], skills: [], unavailableReason: null }
}
`)
  writeFileSync(join(node.state, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'gate', specifier: pathToFileURL(plugin).href, enabled: true }] }))
  return { gate, builds }
}

function serve(node: Node): BuckleProcess {
  const started = spawnBuckle({ entry, args: ['serve'], env: node.env, cwd: node.workspace })
  running.push(started)
  return started
}

function closeSteps(lines: LogLine[]): Array<{ stage: string; name: string }> {
  return lines.filter(line => line.message === 'close step').map(line => ({ stage: String(line.fields?.stage), name: String(line.fields?.name) }))
}

function stageOrder(steps: Array<{ stage: string }>): number[] {
  return steps.map(step => CLOSE_STAGES.indexOf(step.stage as typeof CLOSE_STAGES[number]))
}

describe('the built bin', () => {
  it('is executable, starts with the node shebang, and runs directly and through a symlink', () => {
    expect(statSync(entry).mode & 0o111).toBe(0o111)
    expect(readFileSync(entry, 'utf8').split('\n', 1)[0]).toBe('#!/usr/bin/env node')
    const link = join(mkdtempSync(join(tmpdir(), 'buckle-link-')), 'buckle')
    symlinkSync(entry, link)
    for (const command of [entry, link]) {
      expect(execFileSync(command, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  it('runs when node is given the entry without its extension', () => {
    expect(execFileSync(process.execPath, [entry.replace(/\.js$/, ''), '--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('a .env in the current directory when no configuration file resolves', () => {
  it('refuses serve, mcp and CLI commands, naming BUCKLE_ENV_FILE and buckle init, without reading its values', async () => {
    const node = await prepareNode()
    const { BUCKLE_ENV_FILE: _unset, ...env } = node.env
    const elsewhere = join(node.root, 'elsewhere-state')
    writeFileSync(join(node.workspace, '.env'), `# owner settings\nexport BUCKLE_STATE_DIR=${elsewhere}\nBUCKLE_AUTH_TOKEN=dotenv-secret-value\n`)
    for (const args of [['serve'], ['mcp'], ['tools']]) {
      const run = spawnBuckle({ entry, args, env, cwd: node.workspace })
      running.push(run)
      expect(await run.exited).toEqual({ code: 1, signal: null })
      expect(run.stderr()).toContain('BUCKLE_ENV_FILE')
      expect(run.stderr()).toContain('buckle init')
      expect(run.stderr()).not.toContain('dotenv-secret-value')
    }
    expect(existsSync(elsewhere)).toBe(false)
  }, 60_000)

  it('still answers --version and help, which need no configuration', async () => {
    const node = await prepareNode()
    const { BUCKLE_ENV_FILE: _unset, ...env } = node.env
    writeFileSync(join(node.workspace, '.env'), 'BUCKLE_AUTH_TOKEN=dotenv-secret-value\n')
    for (const args of [['--version'], ['help']]) {
      const run = spawnBuckle({ entry, args, env, cwd: node.workspace })
      running.push(run)
      expect(await run.exited).toEqual({ code: 0, signal: null })
      expect(run.stderr()).toBe('')
    }
  }, 60_000)

  it('refuses a CLI command with one plain line, not a JSON log line with a stack', async () => {
    const node = await prepareNode()
    const { BUCKLE_ENV_FILE: _unset, ...env } = node.env
    writeFileSync(join(node.workspace, '.env'), 'BUCKLE_AUTH_TOKEN=dotenv-secret-value\n')
    const run = spawnBuckle({ entry, args: ['tools'], env, cwd: node.workspace })
    running.push(run)
    expect(await run.exited).toEqual({ code: 1, signal: null })
    const lines = run.stderr().trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\/.+\.env sets BUCKLE_ variables/)
  }, 60_000)

  it('runs as before when that .env names no BUCKLE_ variable', async () => {
    const node = await prepareNode()
    const { BUCKLE_ENV_FILE: _unset, ...env } = node.env
    writeFileSync(join(node.workspace, '.env'), 'OTHER_TOOL=1\n# BUCKLE_STATE_DIR is only mentioned here\n')
    const run = spawnBuckle({ entry, args: ['tools'], env, cwd: node.workspace })
    running.push(run)
    expect(await run.exited).toEqual({ code: 0, signal: null })
  }, 60_000)
})

describe('buckle serve bootstrap (built dist and .output)', () => {
  it('listens before startup ends, answers 503 until ready, builds the workspace once, and closes stage by stage on SIGTERM', async () => {
    const node = await prepareNode()
    const { gate, builds } = installGatePlugin(node)
    const buckle = serve(node)
    const url = (path: string) => `http://127.0.0.1:${node.port}${path}`

    const starting = await firstResponse(url('/health/ready'))
    expect(starting.status).toBe(503)
    expect(await starting.json()).toEqual({ error: 'Runtime is still starting' })
    // Liveness answers during startup; everything else waits for readiness.
    const live = await fetch(url('/health'))
    expect(live.status).toBe(200)
    expect(await live.json()).toMatchObject({ status: 'ok', serverId: expect.any(String) })
    // B15 flip: /v1 is Nitro's, which answers with the readiness message.
    const early = await fetch(url('/v1/manifest'), { headers: { authorization: 'Bearer bootstrap-agent-token' } })
    expect(early.status).toBe(503)
    expect(await early.json()).toEqual({ error: 'Runtime is still starting' })
    closeSync(openSync(gate, 'w'))
    const ready = await waitForStatus(url('/health/ready'), 200)
    expect(await ready.json()).toEqual({ status: 'ready' })
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')
    expect(readFileSync(builds, 'utf8')).toBe('x')
    // The workspace-model brief, item 6: the online workspaces, on the terminal questions are asked on.
    await vi.waitFor(() => expect(buckle.stderr()).toMatch(/Serving 1 workspace:\n {2}workspace\n {4}id {6}\S+\n {4}folder {2}/))

    buckle.child.kill('SIGTERM')
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    const steps = closeSteps(buckle.lines())
    expect(steps).toEqual(expect.arrayContaining([
      { stage: 'accept', name: 'http server' },
      { stage: 'waiters', name: 'terminal questions' },
      { stage: 'waiters', name: 'approval waits' },
      // B19: running tool calls, PTY terminals, language servers, browser sessions and action reports.
      { stage: 'jobs', name: 'tool calls' },
      { stage: 'jobs', name: 'workspace list' },
      { stage: 'streams', name: 'workbench terminals' },
      { stage: 'streams', name: 'language servers and browser sessions' },
      { stage: 'streams', name: 'http server connections' },
      { stage: 'locks', name: 'workbench ownership' },
      { stage: 'services', name: 'service registry' },
      { stage: 'databases', name: 'workspace history' },
      { stage: 'sinks', name: 'action reports' },
      { stage: 'sinks', name: 'logger' },
    ]))
    const order = stageOrder(steps)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(buckle.lines().at(-1)?.message).toBe('5straps Buckle stopped')
  }, 60_000)

  it('closes stage by stage and exits 0 on SIGINT too, with no client, well within one close step\'s bound', async () => {
    const node = await prepareNode()
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')

    const stopping = performance.now()
    buckle.child.kill('SIGINT')
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    // A leaked pre-cut-over serve once outlived its SIGINT; nothing here waits out a bound.
    expect(performance.now() - stopping).toBeLessThan(10_000)
    expect(buckle.lines()).toContainEqual(expect.objectContaining({ message: 'Shutdown requested', fields: expect.objectContaining({ signal: 'SIGINT' }) }))
    const steps = closeSteps(buckle.lines())
    expect(steps).toEqual(expect.arrayContaining([{ stage: 'accept', name: 'http server' }, { stage: 'databases', name: 'workspace history' }, { stage: 'sinks', name: 'logger' }]))
    const order = stageOrder(steps)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(buckle.lines().at(-1)?.message).toBe('5straps Buckle stopped')
  }, 60_000)

  it('settles a call waiting for approval as approval_required on SIGTERM, keeps its ask pending, and exits 0', async () => {
    const node = await prepareNode({ BUCKLE_APPROVAL_TIMEOUT_MS: '0', BUCKLE_PACKS: 'fs' })
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')
    const pendingTokens = () => existsSync(join(node.state, 'workspaces', workspaceIdOf(node.workspace), 'approvals.json'))
      ? (JSON.parse(readFileSync(join(node.state, 'workspaces', workspaceIdOf(node.workspace), 'approvals.json'), 'utf8')) as { pending: Array<{ request: { token: string } }> }).pending.map(entry => entry.request.token)
      : []
    const waiting = fetch(`http://127.0.0.1:${node.port}/v1/invoke`, { method: 'POST', headers: { authorization: 'Bearer bootstrap-agent-token', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'held-write', tool: 'fs_write', args: { path: 'held.md', content: 'must not land' } }) })
    await expect.poll(pendingTokens, { timeout: 20_000 }).toHaveLength(1)
    const [token] = pendingTokens()

    buckle.child.kill('SIGTERM')

    expect(await (await waiting).json()).toMatchObject({ outcome: 'approval_required', approvals: [{ token }] })
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    expect(pendingTokens()).toEqual([token])
    expect(closeSteps(buckle.lines())).toContainEqual({ stage: 'waiters', name: 'approval waits' })
    expect(existsSync(join(node.workspace, 'held.md'))).toBe(false)
  }, 60_000)

  it('cancels a running shell on SIGTERM: the call answers BUCKLE_SHUTTING_DOWN with 503, the process is gone, and Buckle exits 0 with no close step running out its bound (B19)', async () => {
    const marker = `${31 + Math.random()}`.slice(0, 12)
    const node = await prepareNode({ BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'shell', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'bootstrap-admin-token', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const owner = generateSigningKey()
    const cli = (args: string[]) => execFileSync(process.execPath, [entry, ...args], { cwd: node.workspace, env: node.env, encoding: 'utf8' })
    expect(cli(['keys', 'enroll', owner.publicKey, '--purpose', 'approval', '--workspace', 'workspace'])).toContain(owner.keyId)
    const nodePublicKey = /Public key: +(ed25519:\S+)/.exec(cli(['keys', 'node']))![1]!
    const authorization = (method: string, path: string, body: string) => signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: 'local-dev', nodeKey: keyIdOf(nodePublicKey), workspace: workspaceIdOf(node.workspace), method, path, body })
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')
    // Unsandboxed, the command word is spawned by the path PATH gives, so ps shows `/usr/bin/sleep <marker>` or the like.
    const running = () => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').some(line => {
      const [program, ...args] = line.trim().split(' ')
      return /(^|\/)sleep$/.test(program ?? '') && args.join(' ') === marker
    })
    const waiting = fetch(`http://127.0.0.1:${node.port}/v1/invoke`, { method: 'POST', headers: { authorization: 'Bearer bootstrap-agent-token', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'long-shell', tool: 'shell_exec', args: { command: 'sleep', args: [marker] } }) })
    // The shell stays held until an enrolled device verifies and signs its exact action.
    const approvals = join(node.state, 'workspaces', workspaceIdOf(node.workspace), 'approvals.json')
    const pending = () => existsSync(approvals) ? (JSON.parse(readFileSync(approvals, 'utf8')) as { pending: Array<{ request: { token: string } }> }).pending.map(entry => entry.request.token) : []
    await expect.poll(pending, { timeout: 20_000 }).toHaveLength(1)
    const token = pending()[0]!
    const decisions = `/workspaces/${workspaceIdOf(node.workspace)}/setup/approvals`
    const unsigned = await fetch(`http://127.0.0.1:${node.port}${decisions}`, { method: 'POST', headers: { authorization: 'Bearer bootstrap-admin-token', 'content-type': 'application/json' }, body: JSON.stringify({ token, approved: true, scope: 'once' }) })
    expect(unsigned.status).toBe(409)
    expect(running()).toBe(false)
    const path = `${decisions}/challenges`
    const listed = await fetch(`http://127.0.0.1:${node.port}${path}`, { headers: { authorization: authorization('GET', path, '') } })
    expect(listed.status).toBe(200)
    const item = ((await listed.json()) as { challenges: Array<{ token: string; signed: string; digest: string }> }).challenges.find(item => item.token === token)!
    const verified = readChallenge({ signed: item.signed, nodeKey: publicKeyFrom(nodePublicKey) })!
    expect(verified.digest).toBe(item.digest)
    expect(verified.challenge).toMatchObject({ token, tool: 'shell_exec', arguments: { command: 'sleep', args: [marker] }, cwd: node.workspace })
    const body = JSON.stringify({ token, approved: true, scope: 'once', challenge: verified.digest })
    const answered = await fetch(`http://127.0.0.1:${node.port}${decisions}`, { method: 'POST', headers: { authorization: authorization('POST', decisions, body), 'content-type': 'application/json' }, body })
    expect(answered.status).toBe(200)
    await expect.poll(running, { timeout: 20_000 }).toBe(true)

    buckle.child.kill('SIGTERM')

    // Review L7 and L12 of B18-B19: the cancelled call says why, as a 503.
    const reply = await waiting
    expect(reply.status).toBe(503)
    expect(await reply.json()).toMatchObject({ requestId: 'long-shell', outcome: 'error', error: { code: 'BUCKLE_SHUTTING_DOWN', retryable: false } })
    // Exit 0 means no close step ran out its bound: one that did fails the close, which exits 1. No wall clock, so a slow ARM64 runner does not flake.
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    expect(buckle.lines().map(line => line.message)).not.toContain('Buckle closed with errors')
    expect(running()).toBe(false)
    expect(closeSteps(buckle.lines())).toContainEqual({ stage: 'jobs', name: 'tool calls' })
  }, 60_000)

  it('logs one path-free completion line per request, refused and unrouted ones included (B19)', async () => {
    const node = await prepareNode({ BUCKLE_PACKS: 'fs' })
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')
    const url = (path: string) => `http://127.0.0.1:${node.port}${path}`
    const agent = { authorization: 'Bearer bootstrap-agent-token', 'x-request-id': 'caller-7' }
    expect((await fetch(url('/v1/skills/zq81-agent-chosen'), { headers: agent })).status).toBe(404)
    expect((await fetch(url('/v1/manifest'), { headers: { authorization: 'Bearer zq81-wrong-token' } })).status).toBe(401)
    expect((await fetch(url('/zq81-nowhere'))).status).toBe(404)
    expect((await fetch(url('/v1/manifest'), { headers: agent })).status).toBe(200)

    buckle.child.kill('SIGTERM')
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    const finished = buckle.lines().filter(line => line.message === 'request finished').map(line => line.fields ?? {})
    expect(finished).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', route: '/v1/skills/:skillId', status: 404, actor: 'agent:node', workspaceId: workspaceIdOf(node.workspace), clientRequestId: 'caller-7' }),
      expect.objectContaining({ method: 'GET', route: '/v1/manifest', status: 401 }),
      expect.objectContaining({ method: 'GET', route: null, status: 404 }),
      expect.objectContaining({ method: 'GET', route: '/v1/manifest', status: 200, actor: 'agent:node' }),
    ]))
    for (const fields of finished) {
      expect(fields).toMatchObject({ durationMs: expect.any(Number), correlationId: expect.stringMatching(/^[\da-f-]{36}$/) })
    }
    const text = JSON.stringify(finished)
    for (const secret of ['zq81', 'bootstrap-agent-token', node.state]) expect(text).not.toContain(secret)
  }, 60_000)

  it('stops with exit 0, without serving, when SIGTERM arrives during the startup window', async () => {
    const node = await prepareNode()
    const { gate } = installGatePlugin(node)
    const buckle = serve(node)
    expect((await firstResponse(`http://127.0.0.1:${node.port}/health/ready`)).status).toBe(503)

    buckle.child.kill('SIGTERM')
    await buckle.waitForLine(line => line.message === 'Shutdown requested')
    // Close waits for the workspace being built, so let that build finish.
    closeSync(openSync(gate, 'w'))
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    const messages = buckle.lines().map(line => line.message)
    expect(messages).not.toContain('Buckle failed to start')
    expect(messages).not.toContain('5straps Buckle listening')
  }, 60_000)

  it('exits 1, before listening, when the package has no built server', async () => {
    const node = await prepareNode()
    // The package as built, less .output: dist and the files it reads from the package root.
    const bare = mkdtempSync(join(tmpdir(), 'buckle-no-output-'))
    for (const part of ['dist', 'skills', 'package.json']) cpSync(join(inject('buckleBuild').root, part), join(bare, part), { recursive: true })
    symlinkSync(join(inject('buckleBuild').root, 'node_modules'), join(bare, 'node_modules'), 'dir')
    const buckle = spawnBuckle({ entry: join(bare, 'dist', 'main.js'), args: ['serve'], env: node.env, cwd: node.workspace })
    running.push(buckle)

    expect(await buckle.exited).toEqual({ code: 1, signal: null })
    expect(buckle.lines().find(line => line.message === 'Buckle failed to start')).toMatchObject({ level: 'fatal', error: { message: expect.stringContaining(join(bare, '.output', 'server', 'index.mjs')) } })
  }, 60_000)

  it('answers an upgrade request as a plain request: Buckle serves no WebSocket', async () => {
    const node = await prepareNode()
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')
    for (const path of ['/health', '/mcp']) {
      const socket = connect(node.port, '127.0.0.1')
      let reply = ''
      socket.on('data', (chunk: Buffer) => { reply += chunk.toString('utf8') })
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
      await expect.poll(() => reply.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 \d{3}/)
      socket.destroy()
      // B18 flip: srvx writes the Response's own status text, which is empty, so the reason phrase is too (RFC 9112 makes it optional).
      expect(reply.split('\r\n')[0]).toMatch(path === '/health' ? /^HTTP\/1\.1 200( |$)/ : /^HTTP\/1\.1 401( |$)/)
    }
    expect((await fetch(`http://127.0.0.1:${node.port}/health/ready`)).status).toBe(200)
  }, 60_000)

  it('exits 1 with the reason when startup fails after listening', async () => {
    const node = await prepareNode({ BUCKLE_PACKS: 'no-such-pack' })
    const buckle = serve(node)

    expect(await buckle.exited).toEqual({ code: 1, signal: null })
    const failure = buckle.lines().find(line => line.message === 'Buckle failed to start')
    expect(failure).toMatchObject({ level: 'fatal', error: { message: expect.stringContaining('Invalid BUCKLE_PACKS: Unknown pack no-such-pack') } })
    expect(buckle.lines().some(line => line.message === '5straps Buckle listening')).toBe(false)
    expect(existsSync(join(node.state, 'actions.jsonl'))).toBe(false)
  }, 60_000)
})

describe('an environment file other users can read (review M4, warn only)', () => {
  it('runs, and warns once naming chmod 600 and the file, without printing a value', async () => {
    const node = await prepareNode()
    const file = join(node.root, 'loose.env')
    // The node's own settings, as a 0.1 file held them: migration reads them from the file alone (finding 34).
    const { BUCKLE_WORKSPACE_ROOT: root, BUCKLE_AUTH_TOKEN: token, BUCKLE_ALLOW_SHELL: shell, ...env } = node.env
    writeFileSync(file, `BUCKLE_SERVER_NAME=loose-value-fixture\nBUCKLE_WORKSPACE_ROOT=${root}\nBUCKLE_AUTH_TOKEN=${token}\nBUCKLE_ALLOW_SHELL=${shell}\n`, { mode: 0o644 })
    chmodSync(file, 0o644)
    const run = spawnBuckle({ entry, args: ['tools'], env: { ...env, BUCKLE_ENV_FILE: file }, cwd: node.workspace })
    running.push(run)
    expect(await run.exited).toEqual({ code: 0, signal: null })
    const warnings = run.lines().filter(line => line.level === 'warn' && line.message.includes(`chmod 600 ${file}`))
    expect(warnings).toHaveLength(1)
    expect(run.stderr()).not.toContain('loose-value-fixture')
  }, 60_000)
})

describe('a state directory other users can reach (ruling 7)', () => {
  it('refuses serve, mcp and CLI commands, naming the repair, and touches nothing inside', async () => {
    const node = await prepareNode()
    chmodSync(node.state, 0o755)
    for (const args of [['serve'], ['mcp'], ['tools']]) {
      const run = spawnBuckle({ entry, args, env: node.env, cwd: node.workspace })
      running.push(run)
      expect(await run.exited).toEqual({ code: 1, signal: null })
      expect(run.stderr()).toContain(`chmod 700 ${node.state}`)
      expect(run.stderr()).toContain('--skip-owner-only-check')
    }
    expect(readdirSync(node.state)).toEqual([])
  }, 60_000)

  it('with --skip-owner-only-check before or after the command word, runs commands, buckle policy included, and serve, warning once naming the directory', async () => {
    const node = await prepareNode()
    chmodSync(node.state, 0o755)
    const warned = (run: BuckleProcess) => run.lines().filter(line => line.level === 'warn' && line.message.includes(`Directory ${node.state} is accessible to other users`))
    for (const args of [['--skip-owner-only-check', 'tools'], ['policy', 'show', '--skip-owner-only-check']]) {
      const run = spawnBuckle({ entry, args, env: node.env, cwd: node.workspace })
      running.push(run)
      expect(await run.exited).toEqual({ code: 0, signal: null })
      expect(warned(run)).toHaveLength(1)
    }
    const served = spawnBuckle({ entry, args: ['serve', '--skip-owner-only-check'], env: node.env, cwd: node.workspace })
    running.push(served)
    await waitForStatus(`http://127.0.0.1:${node.port}/health/ready`, 200)
    expect(warned(served)).toHaveLength(1)
    served.child.kill('SIGTERM')
    expect(await served.exited).toEqual({ code: 0, signal: null })
    expect(statSync(node.state).mode & 0o777).toBe(0o755)
  }, 60_000)
})

// D83 (4) and the workspace-model brief, item 3, in place of the outside-the-root warning of owner decision D5: a
// command runs on the workspace whose folder holds the directory it starts in, or the one it names; `buckle mcp` also
// takes BUCKLE_WORKSPACE_ROOT, which MCP configs written before the workspace model set. Elsewhere it refuses, naming
// the ids and no folder.
describe('a project outside every workspace\'s folder', () => {
  // The state directory's own file names the root and token, as 0.1's `buckle init` wrote them; the first command migrates.
  async function nodeFromFile(): Promise<{ node: Node; env: NodeJS.ProcessEnv; elsewhere: string }> {
    const node = await prepareNode()
    // Migration reads the file alone, so the workspace keys are the file's too (finding 34 of the Phase 1 review).
    writeFileSync(join(node.state, 'buckle.env'), `BUCKLE_WORKSPACE_ROOT=${node.workspace}\nBUCKLE_AUTH_TOKEN=outside-root-agent-token\nBUCKLE_PACKS=fs\nBUCKLE_ALLOW_SHELL=false\n`, { mode: 0o600 })
    const { BUCKLE_ENV_FILE: _file, BUCKLE_WORKSPACE_ROOT: _root, BUCKLE_AUTH_TOKEN: _token, BUCKLE_ALLOW_SHELL: _shell, ...env } = node.env
    const elsewhere = join(node.root, 'another-project')
    mkdirSync(elsewhere)
    const migrate = spawnBuckle({ entry, args: ['tools'], env, cwd: node.workspace })
    running.push(migrate)
    expect(await migrate.exited).toEqual({ code: 0, signal: null })
    return { node, env, elsewhere }
  }

  it('refuses a tool call there, naming the ids and no folder, and runs it on the workspace named', async () => {
    const { node, env, elsewhere } = await nodeFromFile()
    for (const args of [['call', 'fs_list', '--json', '{"path":"."}'], ['fs', 'list']]) {
      const refused = spawnBuckle({ entry, args, env, cwd: elsewhere })
      running.push(refused)
      expect(await refused.exited).toEqual({ code: 1, signal: null })
      expect(refused.stderr()).toContain('No workspace holds the current directory. Name one with --workspace <name> (workspace)')
      expect(refused.stderr()).not.toContain(node.workspace)
      expect(refused.stderr()).not.toContain('outside-root-agent-token')
    }
    const named = spawnBuckle({ entry, args: ['fs', 'list', '--workspace', 'workspace'], env, cwd: elsewhere })
    running.push(named)
    expect(await named.exited).toEqual({ code: 0, signal: null })
  }, 60_000)

  // Finding 1 of the Phase 1 review: the line 0.1's buckle init wrote stays in buckle.env, and must not steer buckle mcp.
  it('serves buckle mcp the folder its own environment names in BUCKLE_WORKSPACE_ROOT, never buckle.env\'s line, which it names at start', async () => {
    const { node, env, elsewhere } = await nodeFromFile()
    writeFileSync(join(node.state, 'buckle.env'), `BUCKLE_WORKSPACE_ROOT=${node.workspace}\n`, { mode: 0o600 })
    const refused = spawnBuckle({ entry, args: ['mcp'], env, cwd: elsewhere, stdin: 'pipe' })
    running.push(refused)
    expect(await refused.exited).toEqual({ code: 1, signal: null })
    expect(refused.stderr()).toContain('No workspace holds the current directory')
    expect(refused.lines().some(line => line.level === 'warn' && line.message.includes('Add --workspace <name> to your MCP configs, then, once you no longer need the way back to 0.1, run buckle settings unset root'))).toBe(true)

    const legacy = spawnBuckle({ entry, args: ['mcp'], env: { ...env, BUCKLE_WORKSPACE_ROOT: node.workspace }, cwd: elsewhere, stdin: 'pipe' })
    running.push(legacy)
    expect((await legacy.waitForLine(line => line.message === '5straps Buckle MCP stdio ready')).fields?.workspaceId).toBe(workspaceIdOf(node.workspace))
    legacy.child.stdin!.end()
    expect(await legacy.exited).toEqual({ code: 0, signal: null })
  }, 60_000)
})

// The workspace-model brief, item 3, and finding 23 of the Phase 1 review: buckle mcp serves --workspace, else --dir,
// else the BUCKLE_WORKSPACE_ROOT its own environment sets, else the workspace holding the directory it starts in.
describe('the workspace buckle mcp serves (built dist)', () => {
  async function twoWorkspaces(): Promise<{ env: NodeJS.ProcessEnv; projA: string; projB: string }> {
    const node = await prepareNode({ BUCKLE_ADMIN_TOKEN: 'mcp-pick-admin-fixture' })
    const { BUCKLE_WORKSPACE_ROOT: _root, BUCKLE_AUTH_TOKEN: _token, ...env } = node.env
    const projA = join(node.root, 'proj-a')
    const projB = join(node.root, 'proj-b')
    for (const [dir, id] of [[projA, 'proja'], [projB, 'projb']] as const) {
      mkdirSync(dir)
      const made = spawnBuckle({ entry, args: ['workspace', 'init', '--name', id], env, cwd: dir })
      running.push(made)
      expect(await made.exited).toEqual({ code: 0, signal: null })
    }
    return { env, projA, projB }
  }

  async function served(input: { env: NodeJS.ProcessEnv; cwd: string; args?: string[] }): Promise<unknown> {
    const run = spawnBuckle({ entry, args: ['mcp', ...input.args ?? []], env: input.env, cwd: input.cwd, stdin: 'pipe' })
    running.push(run)
    const ready = await run.waitForLine(line => line.message === '5straps Buckle MCP stdio ready')
    run.child.stdin!.end()
    expect(await run.exited).toEqual({ code: 0, signal: null })
    return ready.fields?.workspaceId
  }

  it('serves the workspace holding the directory it starts in, where nothing names one', async () => {
    const { env, projB } = await twoWorkspaces()
    expect(await served({ env, cwd: projB })).toBe(workspaceIdOf(projB))
  }, 60_000)

  it('serves the workspace --dir or --workspace names over the BUCKLE_WORKSPACE_ROOT its environment sets, and that one without them', async () => {
    const { env, projA, projB } = await twoWorkspaces()
    const legacy = { ...env, BUCKLE_WORKSPACE_ROOT: projA }
    expect(await served({ env: legacy, cwd: projA, args: ['--dir', projB] })).toBe(workspaceIdOf(projB))
    expect(await served({ env: legacy, cwd: projA, args: ['--workspace', 'projb'] })).toBe(workspaceIdOf(projB))
    expect(await served({ env: legacy, cwd: projB })).toBe(workspaceIdOf(projA))
  }, 60_000)

  // Finding 24: help starts nothing, needs no configuration, and prints the usage.
  it.each([['mcp', '--help'], ['mcp', '-h'], ['serve', '--help'], ['serve', '-h']])('prints the usage for buckle %s %s and starts nothing', async (command, flag) => {
    const state = join(tmpdir(), 'buckle-help-state-never-made')
    // Bounded, so a service that starts instead fails the test rather than holding it open.
    const printed = execFileSync(entry, [command, flag], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, BUCKLE_STATE_DIR: state, BUCKLE_PORT: String(await freePort()) } })
    expect(printed).toContain(`Usage: buckle ${command}`)
    expect(existsSync(state)).toBe(false)
  }, 30_000)
})

// Fix round 3 of the workspace model, on buckle mcp resolving its workspace once: a workspace the owner takes offline,
// removes, or removes and registers again must stop being served by a process that started before the change.
describe('a buckle mcp process whose workspace changes under it (built dist)', () => {
  /** A node with workspace `site` in a project folder, and a buckle mcp serving it: owner commands, a read, and the node's root. */
  async function serving() {
    const node = await prepareNode({ BUCKLE_ADMIN_TOKEN: 'mcp-guard-admin-fixture' })
    const { BUCKLE_WORKSPACE_ROOT: _root, BUCKLE_AUTH_TOKEN: _token, ...env } = node.env
    const project = join(node.root, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'which.txt'), 'OLD-CONTENT')
    const owner = async (args: string[]) => {
      const run = spawnBuckle({ entry, args, env, cwd: project })
      running.push(run)
      return run.exited
    }
    expect(await owner(['workspace', 'init', '--name', 'site'])).toEqual({ code: 0, signal: null })

    const mcp = spawnBuckle({ entry, args: ['mcp', '--workspace', 'site'], env, cwd: node.root, stdin: 'pipe' })
    running.push(mcp)
    const replies: Array<{ id?: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }> = []
    let pending = ''
    mcp.child.stdout!.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') replies.push(JSON.parse(line))
    })
    let next = 0
    const send = async (method: string, params: Record<string, unknown>) => {
      const id = ++next
      mcp.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      await vi.waitFor(() => expect(replies.some(reply => reply.id === id)).toBe(true), { timeout: 20_000, interval: 50 })
      return replies.find(reply => reply.id === id)!
    }
    const read = async () => {
      const reply = await send('tools/call', { name: 'fs_read', arguments: { path: 'which.txt' } })
      return { failed: reply.result?.isError === true, text: reply.result?.content?.map(part => part.text).join('\n') ?? '' }
    }
    await mcp.waitForLine(line => line.message === '5straps Buckle MCP stdio ready')
    await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'guard-test', version: '0.0.0' } })
    mcp.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return { node, env, project, owner, mcp, read }
  }

  it('answers each call with a refusal naming the workspace once it is offline, removed, or registered again, and serves it again once enabled', async () => {
    const { node, owner, mcp, read } = await serving()

    expect(await read()).toMatchObject({ failed: false, text: expect.stringContaining('OLD-CONTENT') })

    expect(await owner(['workspace', 'disable', 'site'])).toEqual({ code: 0, signal: null })
    const offline = await read()
    expect(offline.failed).toBe(true)
    expect(offline.text).toContain('Workspace site is not served now: it is offline')
    expect(offline.text).not.toContain(node.root)

    expect(await owner(['workspace', 'enable', 'site'])).toEqual({ code: 0, signal: null })
    expect(await read()).toMatchObject({ failed: false, text: expect.stringContaining('OLD-CONTENT') })

    expect(await owner(['workspace', 'remove', 'site'])).toEqual({ code: 0, signal: null })
    const removed = await read()
    expect(removed.failed).toBe(true)
    expect(removed.text).toContain('Workspace site is not served now: it was removed')
    expect(removed.text).not.toContain(node.root)

    // The same folder registered again is a new registration: the process serves none of it until it is restarted.
    expect(await owner(['workspace', 'init', '--name', 'site'])).toEqual({ code: 0, signal: null })
    const again = await read()
    expect(again.failed).toBe(true)
    expect(again.text).toContain('Workspace site was removed and registered again')
    expect(again.text).not.toContain(node.root)

    mcp.child.stdin!.end()
    expect(await mcp.exited).toEqual({ code: 0, signal: null })
  }, 90_000)

  // Fix brief 4, finding 32: a stale process kept auditing its refused calls into the folder of a workspace that was purged,
  // which made the folder again, so a later registration reported records it never took up.
  it('audits the refusals of a workspace removed and purged in the node\'s log, making no folder of it, so registering it again takes up nothing', async () => {
    const { node, env, project, owner, mcp, read } = await serving()
    expect(await read()).toMatchObject({ failed: false })
    const [{ id }] = (JSON.parse(readFileSync(join(node.state, 'workspaces.json'), 'utf8')) as { workspaces: { id: string }[] }).workspaces as [{ id: string }]

    expect(await owner(['workspace', 'remove', 'site', '--purge'])).toEqual({ code: 0, signal: null })
    for (let call = 0; call < 2; call++) expect((await read()).failed).toBe(true)

    expect(existsSync(join(node.state, 'workspaces', id))).toBe(false)
    expect(readFileSync(join(node.state, 'actions.jsonl'), 'utf8')).toContain(`"workspaceId":"${id}"`)
    const pruned = execFileSync(entry, ['workspace', 'prune'], { encoding: 'utf8', env, cwd: project })
    expect(pruned).toContain('No removed workspace has records left to prune.')
    const registered = execFileSync(entry, ['workspace', 'init', '--name', 'site'], { encoding: 'utf8', env, cwd: project })
    expect(registered).not.toContain('takes up the records')
    mcp.child.stdin!.end()
    expect(await mcp.exited).toEqual({ code: 0, signal: null })
  }, 90_000)

  // Fix brief 4, finding 10: the refusal for a registry that will not read carried the registry file's path to the agent.
  it.each([
    ['truncated', (text: string) => text.slice(0, -5)],
    ['no longer the shape the node reads', () => JSON.stringify({ version: 2, workspaces: [{ id: 'not-a-uuid' }] })],
  ])('tells the agent the registry cannot be read, naming no path or file, where workspaces.json is %s', async (_how, damage) => {
    const { node, read, mcp } = await serving()
    expect(await read()).toMatchObject({ failed: false })

    const registry = join(node.state, 'workspaces.json')
    writeFileSync(registry, damage(readFileSync(registry, 'utf8')))
    const refused = await read()

    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('Workspace site is not served now: the node\'s registry cannot be read; the owner\'s log says why')
    expect(refused.text).not.toContain(node.root)
    expect(refused.text).not.toContain('workspaces.json')
    mcp.child.stdin!.end()
    expect(await mcp.exited).toEqual({ code: 0, signal: null })
  }, 90_000)
})

describe('buckle mcp bootstrap (built dist)', () => {
  it('closes stage by stage and exits 0 when the client closes stdin', async () => {
    const node = await prepareNode()
    const buckle = spawnBuckle({ entry, args: ['mcp'], env: node.env, cwd: node.workspace, stdin: 'pipe' })
    running.push(buckle)
    await buckle.waitForLine(line => line.message === '5straps Buckle MCP stdio ready')

    buckle.child.stdin!.end()
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    expect(closeSteps(buckle.lines())).toEqual(expect.arrayContaining([{ stage: 'accept', name: 'mcp stdio' }, { stage: 'services', name: 'service registry' }]))
  }, 60_000)
})
