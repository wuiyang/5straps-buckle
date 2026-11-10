import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, inject, it, vi } from 'vitest'
import { readRecord, requestStop } from '../../common/services/node-service/serve-record.js'
import { serviceLogPath } from '../../common/domain/node-service-paths.js'
import { freePort, waitForStatus } from '../support/buckle-process.js'

// Phase 3, item 1 of the workspace-model slice: `buckle serve --background` starts a node detached from the terminal,
// records its pid under the state directory, logs to the state directory's one rotating file, and stops when
// `buckle service stop` asks it to, as Windows delivers a service no SIGTERM.

const entry = inject('buckleBuild').main
const started: number[] = []

afterAll(() => {
  for (const pid of started) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

interface Node { root: string; workspace: string; state: string; env: NodeJS.ProcessEnv; port: number }

async function prepareNode(settings = ''): Promise<Node> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-background-')))
  const workspace = join(root, 'workspace')
  const state = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  const port = await freePort()
  writeFileSync(join(state, 'buckle.env'), `BUCKLE_HOST=127.0.0.1\nBUCKLE_PORT=${port}\nBUCKLE_ADMIN_TOKEN=background-admin-fixture\n${settings}`, { mode: 0o600 })
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: root, BUCKLE_STATE_DIR: state }
  return { root, workspace, state, env, port }
}

function buckle(node: Node, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: node.env, cwd: node.workspace, timeout: 60_000 })
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  if (process.platform !== 'linux') return true
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    return !/^State:\s+Z(?:\s|$)/m.test(status)
  } catch {
    // Retain the successful probe when proc status cannot be read.
    return true
  }
}

function logLines(node: Node): Array<{ level: string; message: string; fields?: Record<string, unknown>; error?: { message: string } }> {
  return readFileSync(serviceLogPath(node.state), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { level: string; message: string })
}

describe('buckle serve --background', () => {
  it('starts a node detached from the terminal, records its pid, logs to the state directory alone, and stops on a stop request', async () => {
    // The CLI display slice, C1: the file stays JSON lines whatever the log's format says.
    const node = await prepareNode('BUCKLE_LOG_FORMAT=human\n')
    const run = buckle(node, ['serve', '--background'])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const shown = /^Buckle runs in the background \(pid (\d+)\) at http:\/\/127\.0\.0\.1:(\d+)\. Answer its approvals with buckle approvals --watch --all; stop it with buckle service stop\.\n$/.exec(run.stdout)
    expect(shown).not.toBeNull()
    const pid = Number(shown![1])
    started.push(pid)
    expect(Number(shown![2])).toBe(node.port)
    expect(alive(pid)).toBe(true)
    expect(readRecord(node.state)).toMatchObject({ pid, manager: 'background', host: '127.0.0.1', port: node.port })
    await waitForStatus(`http://127.0.0.1:${node.port}/health/ready`, 200)

    await vi.waitFor(() => expect(logLines(node).map(line => line.message)).toContain('5straps Buckle listening'), { timeout: 10_000 })
    expect(logLines(node).map(line => line.message)).toContain('Workspaces served')
    expect(readFileSync(serviceLogPath(node.state), 'utf8')).not.toContain('background-admin-fixture')
    expect(statSync(serviceLogPath(node.state)).mode & 0o777).toBe(0o600)
    expect(statSync(join(node.state, 'logs')).mode & 0o777).toBe(0o700)

    // One node per state directory with no terminal (item 5): a second is refused, naming the first.
    const second = buckle(node, ['serve', '--background'])
    expect(second.status).toBe(1)
    expect(second.stderr).toBe(`Buckle is already running in service mode (pid ${pid}), so buckle serve --background starts nothing. Answer its approvals here with: buckle approvals --watch --all\n`)
    // A definition's own serve beside it exits 2, which the systemd unit does not restart on (RestartPreventExitStatus).
    const unit = buckle(node, ['serve', '--service', 'systemd', '--state-dir', node.state])
    expect(unit.status).toBe(2)
    expect(logLines(node)).toContainEqual(expect.objectContaining({ level: 'fatal', message: 'Buckle failed to start', error: expect.objectContaining({ message: 'Buckle is already running in service mode' }) }))
    expect(alive(pid)).toBe(true)

    await requestStop(node.state, pid)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 20_000, interval: 100 })
    expect(readRecord(node.state)).toBeNull()
    const messages = logLines(node).map(line => line.message)
    expect(messages).toContain('Shutdown requested')
    expect(messages.at(-1)).toBe('5straps Buckle stopped')
  }, 90_000)

  it('is shown by buckle service status and logs, and stopped by buckle service stop, before buckle.env is read', async () => {
    const node = await prepareNode()
    const run = buckle(node, ['serve', '--background'])
    expect(run.status).toBe(0)
    const pid = Number(/\(pid (\d+)\)/.exec(run.stdout)![1])
    started.push(pid)

    const status = buckle(node, ['service', 'status'])
    expect(status.status).toBe(0)
    expect(status.stdout).toMatch(new RegExp(`^Running    yes \\(pid ${pid}\\), started by buckle serve --background at `, 'm'))
    expect(status.stdout).toContain(`Address    http://127.0.0.1:${node.port}\nHealth     /health answers; /health/ready answers ready\n`)
    expect(status.stdout).toMatch(/^Version    (\S+) running, \1 installed$/m)
    expect(status.stdout).not.toContain('Next')
    await vi.waitFor(() => expect(buckle(node, ['service', 'logs', '-n', '200']).stdout).toContain('"message":"5straps Buckle listening"'), { timeout: 10_000 })

    const stopped = buckle(node, ['service', 'stop'])
    expect(stopped.stderr).toBe('')
    expect(stopped).toMatchObject({ status: 0, stdout: `Stopped Buckle (pid ${pid}).\n` })
    expect(alive(pid)).toBe(false)
    expect(buckle(node, ['service', 'stop']).stdout).toBe('Buckle is not running.\n')
    // Audited in the node's own log, as buckle settings and buckle init are.
    const audit = readFileSync(join(node.state, 'actions.jsonl'), 'utf8')
    expect(audit).toContain('"tool":"cli_service"')
    expect(audit).not.toContain('background-admin-fixture')
  }, 90_000)

  // Q5 of the 2026-10-15 rulings (Phase 3, item 5): `buckle serve` beside it says so, names the attach command, and starts nothing.
  it('refuses buckle serve beside it, naming buckle approvals --watch for the one online workspace holding this folder, and --all elsewhere', async () => {
    const node = await prepareNode()
    expect(buckle(node, ['workspace', 'init', '--name', 'site']).status).toBe(0)
    const run = buckle(node, ['serve', '--background'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Answer its approvals with buckle approvals --watch; stop it with buckle service stop.')
    const pid = Number(/\(pid (\d+)\)/.exec(run.stdout)![1])
    started.push(pid)

    const beside = buckle(node, ['serve'])
    expect(beside).toMatchObject({ status: 1, stdout: '', stderr: `Buckle is already running in service mode (pid ${pid}), so buckle serve starts nothing. Answer its approvals here with: buckle approvals --watch\n` })
    const elsewhere = spawnSync(process.execPath, [entry, 'serve'], { encoding: 'utf8', env: node.env, cwd: node.root, timeout: 60_000 })
    expect(elsewhere.stderr).toBe(`Buckle is already running in service mode (pid ${pid}), so buckle serve starts nothing. Answer its approvals here with: buckle approvals --watch --all\n`)
    expect(buckle(node, ['service', 'stop']).status).toBe(0)
  }, 90_000)

  // Phase 3, item 3: the Windows task's action is this start, naming where the node lives; it detaches the node and ends,
  // and the node stops on its stop request, as Task Scheduler delivers no SIGTERM. Run here on Linux, imitating it.
  it('starts the node as the Windows task\'s action does, from where the definition names, and stops it by its request', async () => {
    const node = await prepareNode()
    const { BUCKLE_STATE_DIR: _named, ...shell } = node.env
    const run = spawnSync(process.execPath, [entry, 'serve', '--background', '--service', 'task-scheduler', '--state-dir', node.state], { encoding: 'utf8', env: shell, cwd: node.state, timeout: 60_000 })
    expect(run.status).toBe(0)
    const pid = Number(/\(pid (\d+)\)/.exec(run.stdout)![1])
    started.push(pid)
    expect(readRecord(node.state)).toMatchObject({ pid, manager: 'task-scheduler', port: node.port })
    expect(buckle(node, ['service', 'status']).stdout).toContain(`Running    yes (pid ${pid}), started by Task Scheduler at `)
    expect(buckle(node, ['service', 'stop']).stdout).toBe(`Stopped Buckle (pid ${pid}).\n`)
    expect(alive(pid)).toBe(false)
  }, 90_000)

  it('says a node that did not start failed, and its log says why', async () => {
    const node = await prepareNode('BUCKLE_SANDBOX=no-such-sandbox\n')
    const run = buckle(node, ['serve', '--background'])
    expect(run.status).toBe(1)
    expect(run.stderr).toBe('Buckle did not start in the background (exit code 1); buckle service logs shows why.\n')
    expect(existsSync(join(node.state, 'service', 'serve.json'))).toBe(false)
    expect(logLines(node)).toContainEqual(expect.objectContaining({ level: 'fatal', message: 'Buckle failed to start' }))
    expect(readFileSync(serviceLogPath(node.state), 'utf8')).toContain('Invalid BUCKLE_SANDBOX')
  }, 90_000)
})
