import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLOSE_STAGES } from '@5straps/runtime'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { firstResponse, freePort, spawnBuckle, waitForStatus, type BuckleProcess, type LogLine } from '../support/buckle-process.js'

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
    BUCKLE_ENV_FILE: join(root, 'no-environment-file'), BUCKLE_HOST: '127.0.0.1', BUCKLE_PORT: String(port),
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

    buckle.child.kill('SIGTERM')
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    const steps = closeSteps(buckle.lines())
    expect(steps).toEqual(expect.arrayContaining([
      { stage: 'accept', name: 'http server' },
      { stage: 'waiters', name: 'terminal questions' },
      { stage: 'waiters', name: 'approval waits' },
      { stage: 'waiters', name: 'registered workspace approval waits' },
      { stage: 'streams', name: 'http server connections' },
      { stage: 'locks', name: 'workbench ownership' },
      { stage: 'locks', name: 'registered workspace workbenches' },
      { stage: 'services', name: 'service registry' },
      { stage: 'databases', name: 'workspace history' },
      { stage: 'databases', name: 'registered workspace history' },
      { stage: 'sinks', name: 'logger' },
    ]))
    const order = stageOrder(steps)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(buckle.lines().at(-1)?.message).toBe('5straps Buckle stopped')
  }, 60_000)

  it('closes stage by stage and exits 0 on SIGINT too', async () => {
    const node = await prepareNode()
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')

    buckle.child.kill('SIGINT')
    expect(await buckle.exited).toEqual({ code: 0, signal: null })
    expect(buckle.lines()).toContainEqual(expect.objectContaining({ message: 'Shutdown requested', fields: expect.objectContaining({ signal: 'SIGINT' }) }))
    const steps = closeSteps(buckle.lines())
    expect(steps).toEqual(expect.arrayContaining([{ stage: 'accept', name: 'http server' }, { stage: 'databases', name: 'workspace history' }, { stage: 'sinks', name: 'logger' }]))
    const order = stageOrder(steps)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(buckle.lines().at(-1)?.message).toBe('5straps Buckle stopped')
  }, 60_000)

  it('settles a call waiting for approval as approval_required on SIGTERM, keeps its ask pending, and exits 0', async () => {
    const node = await prepareNode({ BUCKLE_APPROVAL_TIMEOUT_MS: 'forever', BUCKLE_PACKS: 'fs' })
    const buckle = serve(node)
    await buckle.waitForLine(line => line.message === '5straps Buckle listening')
    const pendingTokens = () => existsSync(join(node.state, 'approvals.json'))
      ? (JSON.parse(readFileSync(join(node.state, 'approvals.json'), 'utf8')) as { pending: Array<{ request: { token: string } }> }).pending.map(entry => entry.request.token)
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
      expect(reply.split('\r\n')[0]).toBe(path === '/health' ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 401 Unauthorized')
    }
    expect((await fetch(`http://127.0.0.1:${node.port}/health/ready`)).status).toBe(200)
  }, 60_000)

  it('exits 1 with the reason when startup fails after listening', async () => {
    const node = await prepareNode({ BUCKLE_PACKS: 'no-such-pack' })
    const buckle = serve(node)

    expect(await buckle.exited).toEqual({ code: 1, signal: null })
    const failure = buckle.lines().find(line => line.message === 'Buckle failed to start')
    expect(failure).toMatchObject({ level: 'fatal', error: { message: expect.stringContaining('Unknown BUCKLE_PACKS: no-such-pack') } })
    expect(buckle.lines().some(line => line.message === '5straps Buckle listening')).toBe(false)
    expect(existsSync(join(node.state, 'actions.jsonl'))).toBe(false)
  }, 60_000)
})

describe('an environment file other users can read (review M4, warn only)', () => {
  it('runs, and warns once naming chmod 600 and the file, without printing a value', async () => {
    const node = await prepareNode()
    const file = join(node.root, 'loose.env')
    writeFileSync(file, 'BUCKLE_SERVER_NAME=loose-value-fixture\n', { mode: 0o644 })
    chmodSync(file, 0o644)
    const run = spawnBuckle({ entry, args: ['tools'], env: { ...node.env, BUCKLE_ENV_FILE: file }, cwd: node.workspace })
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
    }
    expect(readdirSync(node.state)).toEqual([])
  }, 60_000)
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
