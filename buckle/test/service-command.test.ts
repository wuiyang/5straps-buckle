import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { createRuntimeOwner } from '@5straps/runtime'
import { describe, expect, it, vi } from 'vitest'
import { serviceCommand, SERVICE_USAGE, type ServiceCommandInput } from '../cli/service.js'
import { holdServe, serviceDirectory, serviceLogPath, watchStopRequest, type ServiceManagerKind } from '../common/services/node-service/serve-record.js'
import type { InstalledService, ServiceDefinition, ServiceManager } from '../common/types/ports/service-manager.js'

// Phase 3 of the workspace-model slice: the `buckle service` family over a service manager, here one that imitates a
// platform's, and over a node `buckle serve --background` started. Each subcommand prints one line on success and a
// plain reason on refusal.

interface Node { root: string; state: string; main: string; environment: NodeJS.ProcessEnv }

function node(options: { setUp?: boolean } = {}): Node {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-service-command-')))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  if (options.setUp !== false) writeFileSync(join(state, 'buckle.env'), 'BUCKLE_ADMIN_TOKEN=service-command-admin-fixture\n', { mode: 0o600 })
  const main = join(root, 'dist', 'main.js')
  mkdirSync(join(root, 'dist'))
  writeFileSync(main, '')
  return { root, state, main, environment: { HOME: root, PATH: '/usr/bin:/bin', BUCKLE_STATE_DIR: state } }
}

/** A node serving the state directory with no terminal, in this process, under a pid of its own so a stop request can name it. */
async function serving(state: string, manager: ServiceManagerKind, pid: number): Promise<{ close(): Promise<void> }> {
  const owner = createRuntimeOwner({ name: 'fake-node', services: [] })
  await holdServe({ stateDirectory: state, owner })
  writeFileSync(join(serviceDirectory(state), 'serve.json'), JSON.stringify({ pid, manager, version: '0.1.4', host: '127.0.0.1', port: 4320, startedAt: '2026-10-16T00:00:00.000Z' }))
  owner.onClose('timers', 'stop request', watchStopRequest({ stateDirectory: state, pid, intervalMs: 20, onStop: () => void owner.close() }))
  return { close: () => owner.close() }
}

let nextPid = 900_000

/** A service manager that keeps its definition in memory and starts a node in this process; `signals` gives it a stop of its own, as systemd has. */
function fakeManager(state: string, options: { kind?: 'systemd' | 'task-scheduler'; unavailable?: string; installed?: InstalledService | null; signals?: boolean } = {}) {
  const kind = options.kind ?? 'systemd'
  let installed = options.installed ?? null
  let running: { close(): Promise<void> } | null = null
  const calls: Array<[string, ...unknown[]]> = []
  const begin = async () => { running = await serving(state, kind, nextPid++) }
  const manager: ServiceManager = {
    kind,
    label: 'the imitated definition',
    unavailable: async () => options.unavailable ?? null,
    installed: async () => installed,
    install: async (definition: ServiceDefinition, flags: { now: boolean }) => {
      calls.push(['install', definition, flags])
      installed = { node: definition.node, main: definition.main, thisNode: true, enabled: true }
      if (flags.now) await begin()
    },
    uninstall: async () => { calls.push(['uninstall']); installed = null },
    start: async () => { calls.push(['start']); await begin() },
    ...(options.signals === false ? {} : { stop: async () => { calls.push(['stop']); await running?.close() } }),
  }
  return { manager, calls }
}

async function service(target: Node, argv: string[], manager: ServiceManager | null, extra: Partial<ServiceCommandInput> = {}) {
  let out = ''
  let err = ''
  const result = await serviceCommand({ argv, environment: target.environment, platform: 'linux', cwd: target.root, run: vi.fn(), mainScript: target.main, manager: () => manager, out: text => { out += text }, err: text => { err += text }, ...extra })
  return { ...result, out, err }
}

function audited(state: string): Array<{ tool: string; event: string; outcome: string; detail?: string }> {
  return readFileSync(join(state, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('buckle service, its words', () => {
  it('prints its usage for help, and refuses no subcommand, an unknown one, or an option a subcommand does not take', async () => {
    const target = node()
    expect(await service(target, ['--help'], null)).toMatchObject({ exitCode: 0, out: SERVICE_USAGE, err: '' })
    expect(await service(target, [], null)).toMatchObject({ exitCode: 1, err: SERVICE_USAGE })
    expect(await service(target, ['reload'], null)).toMatchObject({ exitCode: 1, err: SERVICE_USAGE })
    const refused = await service(target, ['install', '--at', 'boot'], null)
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain("Unknown option '--at'")
    expect((await service(target, ['stop', 'now'], null)).err).toContain("Unexpected argument 'now'")
  })
})

// Phase 3, item 4 (Q12): nothing for macOS yet.
describe('buckle service on macOS, where Buckle drives no service manager', () => {
  it('says it is not supported yet and exits 2 for each subcommand a definition needs, pointing at buckle serve --background', async () => {
    const target = node()
    for (const action of ['install', 'uninstall', 'start', 'restart']) {
      expect(await service(target, [action], null, { platform: 'darwin' })).toMatchObject({ exitCode: 2, out: '', err: 'buckle service is not supported yet on macOS: buckle serve --background runs the node until it stops, and buckle service stop, status, and logs work on it.\n' })
    }
    expect(await service(target, ['install', '--now'], null, { platform: 'freebsd' })).toMatchObject({ exitCode: 2, err: expect.stringContaining('not supported yet on freebsd') })
    expect(await service(target, ['stop'], null, { platform: 'darwin' })).toMatchObject({ exitCode: 0, out: 'Buckle is not running.\n' })
    expect((await service(target, ['status'], null, { platform: 'darwin' })).out).toContain('Service    none: buckle service is not supported yet on macOS')
  })
})

describe('buckle service and a node buckle serve --background started', () => {

  it('stops a node buckle serve --background started through its stop request, and audits it in the node\'s log', async () => {
    const target = node()
    await serving(target.state, 'background', 900_001)
    const stopped = await service(target, ['stop'], null)
    expect(stopped).toMatchObject({ exitCode: 0, out: 'Stopped Buckle (pid 900001).\n', err: '' })
    expect(audited(target.state).filter(entry => entry.tool === 'cli_service')).toEqual([
      expect.objectContaining({ event: 'attempt', outcome: 'started' }),
      expect.objectContaining({ event: 'result', outcome: 'ok', detail: 'stop background' }),
    ])
  })

  it('will not restart or start a node buckle serve --background started where no service is installed, and says how', async () => {
    const target = node()
    const { manager } = fakeManager(target.state)
    expect(await service(target, ['start'], manager)).toMatchObject({ exitCode: 1, err: 'No Buckle service is installed: buckle service install installs one, and buckle serve --background runs the node until it stops.\n' })
    expect(await service(target, ['uninstall'], manager)).toMatchObject({ exitCode: 0, out: 'No Buckle service is installed; nothing was removed.\n' })
    const running = await serving(target.state, 'background', 900_002)
    try {
      expect((await service(target, ['restart'], manager)).err).toBe('No Buckle service is installed to restart. A node runs in the background (pid 900002), started by buckle serve --background: stop it with buckle service stop, then start it again with buckle serve --background.\n')
      expect((await service(target, ['start'], manager)).err).toBe('No Buckle service is installed. A node runs in the background (pid 900002), started by buckle serve --background.\n')
    } finally { await running.close() }
  })
})

describe('buckle service install', () => {
  it('writes the definition naming this Node, the built main.js, and where the node lives, as paths', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state)
    const installed = await service(target, ['install'], manager)
    expect(installed).toMatchObject({ exitCode: 0, out: 'Installed the Buckle service (the imitated definition); it starts at every login. Start it now with buckle service start.\n', err: '' })
    expect(calls).toEqual([['install', { node: process.execPath, main: target.main, stateDirectory: target.state, environmentFile: null, path: '/usr/bin:/bin' }, { now: false }]])
    expect(audited(target.state).at(-1)).toMatchObject({ tool: 'cli_service', outcome: 'ok', detail: 'install systemd' })
  })

  it('starts it too with --now, and says its pid', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state)
    const installed = await service(target, ['install', '--now'], manager)
    expect(installed.exitCode).toBe(0)
    expect(installed.out).toMatch(/^Installed and started the Buckle service \(the imitated definition, pid \d+\); it starts at every login\.\n$/)
    expect(calls[0]).toEqual(['install', expect.anything(), { now: true }])
    await service(target, ['stop'], manager)
  })

  it.each([
    ['the manager does not answer', { unavailable: 'No systemd user session answers here' }, 'No systemd user session answers here, so nothing was installed; buckle serve --background runs the node until it stops.\n'],
    ['another state directory\'s definition is installed', { installed: { node: '/usr/bin/node', main: '/opt/buckle/dist/main.js', thisNode: false, enabled: true } }, 'A Buckle service for another state directory is installed, and this machine runs one service. Remove it with buckle service uninstall, then install this node\'s.\n'],
    ['a definition names no state directory', { installed: { node: null, main: null, thisNode: null, enabled: true } }, 'A Buckle service is installed whose definition does not name its state directory, and this machine runs one service. Remove it with buckle service uninstall, then install again.\n'],
  ])('refuses where %s, naming no path', async (_case, options, reason) => {
    const target = node()
    const { manager, calls } = fakeManager(target.state, options)
    const refused = await service(target, ['install', '--now'], manager)
    expect(refused).toMatchObject({ exitCode: 1, err: reason, out: '' })
    expect(calls).toEqual([])
  })

  it('refuses a node that is not set up, and a copy with no dist/main.js', async () => {
    const fresh = node({ setUp: false })
    expect((await service(fresh, ['install'], fakeManager(fresh.state).manager)).err).toBe('This node is not set up yet, and a service reads its settings from its environment file: run buckle init first.\n')
    const unbuilt = node()
    expect((await service(unbuilt, ['install'], fakeManager(unbuilt.state).manager, { mainScript: join(unbuilt.root, 'none', 'main.js') })).err).toBe('A service runs the built Buckle, and this copy has no dist/main.js: build it first with pnpm build.\n')
  })

  it('refuses --now while a node runs in the background, and keeps this node\'s own definition on a second install', async () => {
    const target = node()
    const { manager } = fakeManager(target.state)
    const running = await serving(target.state, 'background', 900_003)
    try {
      expect((await service(target, ['install', '--now'], manager)).err).toBe('A node runs in the background (pid 900003), started by buckle serve --background; stop it first with buckle service stop, then install again.\n')
    } finally { await running.close() }
    expect((await service(target, ['install'], manager)).exitCode).toBe(0)
    expect((await service(target, ['install'], manager)).exitCode).toBe(0)
  })
})

describe('buckle service start, stop, restart, and uninstall', () => {
  it('starts the installed service, says it already runs, stops it through the manager, and removes it', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state)
    await service(target, ['install'], manager)
    const started = await service(target, ['start'], manager)
    expect(started.out).toMatch(/^Started the Buckle service \(pid (\d+)\) at http:\/\/127\.0\.0\.1:4320\.\n$/)
    expect((await service(target, ['start'], manager)).out).toMatch(/^The Buckle service is already running \(pid \d+\)\.\n$/)
    expect((await service(target, ['stop'], manager)).out).toMatch(/^Stopped Buckle \(pid \d+\)\.\n$/)
    expect(calls.map(call => call[0])).toEqual(['install', 'start', 'stop'])
    expect(await service(target, ['uninstall'], manager)).toMatchObject({ exitCode: 0, out: 'Removed the Buckle service (the imitated definition); the state directory is kept.\n' })
  })

  it('restarts through a stop request and a start where the manager cannot signal the node, as on Windows', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state, { kind: 'task-scheduler', signals: false })
    await service(target, ['install', '--now'], manager)
    const restarted = await service(target, ['restart'], manager)
    expect(restarted.out).toMatch(/^Restarted the Buckle service \(pid \d+\) at http:\/\/127\.0\.0\.1:4320\.\n$/)
    expect(calls.map(call => call[0])).toEqual(['install', 'start'])
    // Uninstalling stops the node through its request first, so it closes before its definition goes.
    const removed = await service(target, ['uninstall'], manager)
    expect(removed.out).toBe('Removed the Buckle service (the imitated definition); the state directory is kept.\n')
    expect(await service(target, ['stop'], manager)).toMatchObject({ out: 'Buckle is not running.\n' })
  })

  it('says to install again where the definition names a Node binary or main.js that is gone', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state, { installed: { node: join(target.root, 'nvm', 'v22', 'bin', 'node'), main: join(target.root, 'gone', 'main.js'), thisNode: true, enabled: true } })
    const reason = 'The Buckle service runs a Node binary and a Buckle main.js that is no longer there, as after Node is upgraded or moved; run buckle service install again.\n'
    expect((await service(target, ['start'], manager)).err).toBe(reason)
    expect((await service(target, ['restart'], manager)).err).toBe(reason)
    expect(calls).toEqual([])
  })
})

describe('buckle service logs', () => {
  it('prints the last lines, 50 by default or -n of them, and says when there is no log yet', async () => {
    const target = node()
    expect(await service(target, ['logs'], null)).toMatchObject({ exitCode: 0, out: 'No service log yet: a node writes it once it runs under buckle service or buckle serve --background.\n' })
    mkdirSync(join(target.state, 'logs'))
    writeFileSync(serviceLogPath(target.state), Array.from({ length: 60 }, (_, index) => `{"n":${index}}\n`).join(''))
    const all = await service(target, ['logs'], null)
    expect(all.out.split('\n').filter(Boolean)).toHaveLength(50)
    expect(all.out.startsWith('{"n":10}\n')).toBe(true)
    expect((await service(target, ['logs', '-n', '2'], null)).out).toBe('{"n":58}\n{"n":59}\n')
    expect((await service(target, ['logs', '-n', 'many'], null))).toMatchObject({ exitCode: 1, err: '-n takes a count of lines, 0 or more\n' })
  })

  it('follows with -f: whole lines as they are added, and the new file once it rotates', async () => {
    const target = node()
    mkdirSync(join(target.state, 'logs'))
    const file = serviceLogPath(target.state)
    writeFileSync(file, '{"n":1}\n')
    const stop = new AbortController()
    let out = ''
    const following = serviceCommand({ argv: ['logs', '-f', '-n', '0'], environment: target.environment, platform: 'linux', cwd: target.root, run: vi.fn(), mainScript: target.main, manager: () => null, out: text => { out += text }, err: () => {}, signal: stop.signal })
    appendFileSync(file, '{"n":2}\n{"n":3')
    await vi.waitFor(() => expect(out).toBe('{"n":2}\n'), { timeout: 5_000 })
    appendFileSync(file, '}\n')
    await vi.waitFor(() => expect(out).toBe('{"n":2}\n{"n":3}\n'), { timeout: 5_000 })
    renameSync(file, `${file}.1`)
    writeFileSync(file, '{"n":4}\n')
    await vi.waitFor(() => expect(out).toBe('{"n":2}\n{"n":3}\n{"n":4}\n'), { timeout: 5_000 })
    stop.abort()
    expect(await following).toEqual({ exitCode: 0 })
  })
})
