import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { createRuntimeOwner } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serviceCommand, SERVICE_USAGE, type ServiceCommandInput } from '../cli/service.js'
import { holdServe, runningNode, serviceDirectory, serviceLogPath, watchStopRequest, type ServeManagerKind } from '../common/services/node-service/serve-record.js'
import { startInBackground } from '../server/service-mode.js'
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
async function serving(state: string, manager: ServeManagerKind, pid: number): Promise<{ close(): Promise<void> }> {
  const owner = createRuntimeOwner({ name: 'fake-node', services: [] })
  await holdServe({ stateDirectory: state, owner })
  writeFileSync(join(serviceDirectory(state), 'serve.json'), JSON.stringify({ pid, manager, version: '0.1.4', host: '127.0.0.1', port: 4320, startedAt: '2026-10-16T00:00:00.000Z' }))
  owner.onClose('timers', 'stop request', watchStopRequest({ stateDirectory: state, pid, intervalMs: 20, onStop: () => void owner.close() }))
  return { close: () => owner.close() }
}

let nextPid = 900_000

/**
 * A service manager that keeps its definition in memory and starts a node in this process; `signals` gives it a stop of
 * its own, as systemd has, and `startsNothingBeside` makes a start do nothing while a node serves, as Task Scheduler's
 * does (its action is `serve --background`, which finds the node serving and starts nothing).
 */
function fakeManager(state: string, options: { kind?: 'systemd' | 'task-scheduler'; unavailable?: string; installed?: InstalledService | null; signals?: boolean; startsNothingBeside?: boolean } = {}) {
  const kind = options.kind ?? 'systemd'
  let installed = options.installed ?? null
  let running: { close(): Promise<void> } | null = null
  const calls: Array<[string, ...unknown[]]> = []
  const begin = async () => {
    if (options.startsNothingBeside && await runningNode(state) !== null) return
    running = await serving(state, kind, nextPid++)
  }
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

  it('keeps each line of its usage within the width of the first', () => {
    const [first, ...rest] = SERVICE_USAGE.split('\n')
    expect(rest.filter(line => line.length > first!.length)).toEqual([])
  })
})

// Phase 3, item 4: a platform other than Linux, macOS, and Windows, where Buckle drives no service manager.
describe('buckle service where Buckle drives no service manager', () => {
  it('says it is not supported yet and exits 2 for each subcommand a definition needs, pointing at buckle serve --background', async () => {
    const target = node()
    for (const action of ['install', 'uninstall', 'start', 'restart']) {
      expect(await service(target, [action], null, { platform: 'freebsd' })).toMatchObject({ exitCode: 2, out: '', err: 'buckle service is not supported yet on freebsd: buckle serve --background runs the node until it stops, and buckle service stop, status, and logs work on it.\n' })
    }
    expect(await service(target, ['install', '--now'], null, { platform: 'openbsd' })).toMatchObject({ exitCode: 2, err: expect.stringContaining('not supported yet on openbsd') })
    expect(await service(target, ['stop'], null, { platform: 'freebsd' })).toMatchObject({ exitCode: 0, out: 'Buckle is not running.\n' })
    expect((await service(target, ['status'], null, { platform: 'freebsd' })).out).toContain('Service    none: buckle service is not supported yet on freebsd')
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

// Fix brief 6, item 1: a buckle serve typed at a terminal holds the same lock and records itself as `terminal`, so the
// service family sees it: nothing starts beside it, status shows it, and stop names Ctrl-C at its terminal.
describe('buckle service and a node buckle serve runs at a terminal', () => {
  it('refuses serve --background, start, restart, and install --now beside it, naming Ctrl-C, and starts nothing', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state)
    const running = await serving(target.state, 'terminal', 900_020)
    try {
      expect(await service(target, ['start'], manager)).toMatchObject({ exitCode: 1, err: 'No Buckle service is installed. Buckle runs at a terminal (pid 900020); stop it there with Ctrl-C.\n' })
      expect(await service(target, ['restart'], manager)).toMatchObject({ exitCode: 1, err: 'No Buckle service is installed to restart. Buckle runs at a terminal (pid 900020); stop it there with Ctrl-C, then run buckle serve again.\n' })
      expect(await service(target, ['install', '--now'], manager)).toMatchObject({ exitCode: 1, err: 'Buckle runs at a terminal (pid 900020); stop it there with Ctrl-C, then run buckle service install --now again.\n' })
      expect(calls).toEqual([])
      expect((await service(target, ['install'], manager)).exitCode).toBe(0)
      expect(await service(target, ['start'], manager)).toMatchObject({ exitCode: 1, err: 'Buckle runs at a terminal (pid 900020); stop it there with Ctrl-C, then run buckle service start again.\n' })
      expect(await service(target, ['restart'], manager)).toMatchObject({ exitCode: 1, err: 'Buckle runs at a terminal (pid 900020); stop it there with Ctrl-C, then run buckle service start.\n' })
      expect(calls.map(call => call[0])).toEqual(['install'])
      const background = await startInBackground({ options: { help: false, background: true, service: null, location: {} }, location: { stateDirectory: target.state, environmentFile: null }, mainScript: target.main, skipOwnerOnlyCheck: false, environment: target.environment, cwd: target.root })
      expect(background).toEqual({ exitCode: 1, message: 'Buckle runs at a terminal (pid 900020); stop it there with Ctrl-C, then run buckle serve --background again.' })
    } finally { await running.close() }
  })

  it('is shown by status as started at a terminal, and stop says to press Ctrl-C there, asking nothing of it', async () => {
    const target = node()
    writeFileSync(join(target.root, 'package.json'), JSON.stringify({ version: '0.1.5' }))
    const { manager, calls } = fakeManager(target.state, { installed: { node: process.execPath, main: target.main, thisNode: true, enabled: true } })
    const running = await serving(target.state, 'terminal', 900_021)
    try {
      const shown = (await service(target, ['status'], manager)).out
      expect(shown).toContain('Running    yes (pid 900021), started by buckle serve at a terminal at 2026-10-16T00:00:00.000Z\n')
      expect(shown).toContain('Next       The node runs 0.1.4 and 0.1.5 is installed: stop it with Ctrl-C at its terminal, then run buckle serve again.\n')
      expect(JSON.parse((await service(target, ['status', '--json'], manager)).out).running).toMatchObject({ pid: 900021, startedBy: 'terminal' })
      expect(await service(target, ['stop'], manager)).toMatchObject({ exitCode: 1, out: '', err: 'Buckle runs at a terminal (pid 900021); stop it there with Ctrl-C.\n' })
      expect(await service(target, ['stop'], null)).toMatchObject({ exitCode: 1, err: 'Buckle runs at a terminal (pid 900021); stop it there with Ctrl-C.\n' })
      expect(existsSync(join(serviceDirectory(target.state), 'stop-request'))).toBe(false)
      // Uninstalling where the manager cannot signal its node asks nothing of a serve at a terminal, which is not the service's.
      const unsignalled = fakeManager(target.state, { kind: 'task-scheduler', signals: false, installed: { node: process.execPath, main: target.main, thisNode: true, enabled: true } })
      expect(await service(target, ['uninstall'], unsignalled.manager)).toMatchObject({ exitCode: 0, out: 'Removed the Buckle service (the imitated definition); the state directory is kept.\n' })
      expect(existsSync(join(serviceDirectory(target.state), 'stop-request'))).toBe(false)
      expect(calls).toEqual([])
    } finally { await running.close() }
  })
})

// Fix brief 6, item 11 (findings 19 and 30 of recheck 4): Task Scheduler has no restart, so install --now ran /Run beside
// the old task's node, which started nothing, and the command reported the old pid as started; uninstall asked whatever
// node served to stop, including one a person started by hand with --background.
describe('buckle service install --now and uninstall where the manager has no restart of its own', () => {
  const installedHere: InstalledService = { node: process.execPath, main: '/unused', thisNode: true, enabled: true }

  it('stops the old task\'s node between writing the definition and starting it, and reports the pid of the new one', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state, { kind: 'task-scheduler', signals: false, startsNothingBeside: true, installed: { ...installedHere, main: target.main } })
    const old = await serving(target.state, 'task-scheduler', 900_030)
    const installed = await service(target, ['install', '--now'], manager)
    try {
      expect(installed.err).toBe('')
      expect(installed.exitCode).toBe(0)
      expect(installed.out).toMatch(/^Installed and started the Buckle service \(the imitated definition, pid (\d+)\); it starts at every login\.\n$/)
      expect(installed.out).not.toContain('900030')
      expect(calls.map(call => call[0])).toEqual(['install', 'start'])
      expect(calls[0]).toEqual(['install', expect.anything(), { now: false }])
      expect(audited(target.state).at(-1)).toMatchObject({ tool: 'cli_service', outcome: 'ok', detail: 'install --now task-scheduler' })
    } finally { await old.close(); await service(target, ['stop'], manager) }
  })

  it('starts the first node itself where none runs, with the definition written and started as one step', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state, { kind: 'task-scheduler', signals: false, startsNothingBeside: true })
    const installed = await service(target, ['install', '--now'], manager)
    expect(installed.exitCode).toBe(0)
    expect(calls).toEqual([['install', expect.anything(), { now: true }]])
    await service(target, ['stop'], manager)
  })

  it('leaves a node started by hand with --background running when it uninstalls, as it leaves a serve at a terminal', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state, { kind: 'task-scheduler', signals: false, installed: { ...installedHere, main: target.main } })
    const byHand = await serving(target.state, 'background', 900_031)
    try {
      expect(await service(target, ['uninstall'], manager)).toMatchObject({ exitCode: 0, out: 'Removed the Buckle service (the imitated definition); the state directory is kept.\n' })
      expect(calls).toEqual([['uninstall']])
      expect(existsSync(join(serviceDirectory(target.state), 'stop-request'))).toBe(false)
      expect((await runningNode(target.state))?.record).toMatchObject({ pid: 900_031, manager: 'background' })
    } finally { await byHand.close() }
  })
})

// Finding 18 of recheck 4: troubleshooting.md tells an owner whose state directory modes cannot be set to pass the flag, and
// serve --background passed it on, but a definition had no place for it, so the unit's node refused the directory at every start.
describe('buckle service install and --skip-owner-only-check', () => {
  it('writes the flag into the definition when the command had it, and leaves it out when it did not', async () => {
    const target = node()
    const { manager, calls } = fakeManager(target.state)
    expect((await service(target, ['install'], manager, { skipOwnerOnlyCheck: true })).exitCode).toBe(0)
    expect(calls).toEqual([['install', { node: process.execPath, main: target.main, stateDirectory: target.state, environmentFile: null, path: '/usr/bin:/bin', skipOwnerOnlyCheck: true }, { now: false }]])
    expect((await service(target, ['install'], manager, { skipOwnerOnlyCheck: false })).exitCode).toBe(0)
    expect(calls[1]![1]).not.toHaveProperty('skipOwnerOnlyCheck')
  })

  it('shows in status that the definition starts the node with the flag', async () => {
    const target = node()
    const { manager } = fakeManager(target.state, { installed: { node: process.execPath, main: target.main, thisNode: true, enabled: true, skipsOwnerOnlyCheck: true } })
    expect((await service(target, ['status'], manager)).out).toContain('Service    the imitated definition, starts at login, started with --skip-owner-only-check\n')
    expect(JSON.parse((await service(target, ['status', '--json'], manager)).out).definition).toMatchObject({ skipsOwnerOnlyCheck: true })
    const plain = fakeManager(target.state, { installed: { node: process.execPath, main: target.main, thisNode: true, enabled: true } })
    expect((await service(target, ['status'], plain.manager)).out).not.toContain('skip-owner-only-check')
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
  // Fix brief 6, item 7 (finding 31 of recheck 4): a record a killed node left was read as the new node's while it held
  // the lock and had not listened, so start reported the dead pid and the old address.
  it('reports the node it started, not a record a killed node left, where the new one listens late', async () => {
    const target = node()
    mkdirSync(serviceDirectory(target.state), { recursive: true, mode: 0o700 })
    writeFileSync(join(serviceDirectory(target.state), 'serve.json'), JSON.stringify({ pid: 999_999, manager: 'systemd', version: '0.1.3', host: '127.0.0.1', port: 1111, startedAt: '2026-10-01T00:00:00.000Z' }))
    const owner = createRuntimeOwner({ name: 'late-node', services: [] })
    const { manager } = fakeManager(target.state, { installed: { node: process.execPath, main: target.main, thisNode: true, enabled: true } })
    const late: ServiceManager = { ...manager, start: async () => {
      const hold = await holdServe({ stateDirectory: target.state, owner })
      setTimeout(() => void hold.publish({ manager: 'systemd', version: '0.1.4', host: '127.0.0.1', port: 4320 }), 1_000)
    } }
    try {
      expect(await service(target, ['start'], late)).toMatchObject({ exitCode: 0, out: `Started the Buckle service (pid ${process.pid}) at http://127.0.0.1:4320.\n` })
    } finally { await owner.close() }
  })

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

  // Fix brief 7, item 1: with no node running, stop ends the tries of a definition for this node, and acts on nothing else.
  it('stops the definition for this node when no node runs, and says Buckle is not running where it is another\'s, names none, or the manager cannot stop', async () => {
    const target = node()
    const installed = { node: process.execPath, main: target.main, enabled: true }
    const own = fakeManager(target.state, { installed: { ...installed, thisNode: true } })
    expect(await service(target, ['stop'], own.manager)).toEqual({ exitCode: 0, detail: 'stop systemd', out: 'Stopped the Buckle service (the imitated definition); no node was running.\n', err: '' })
    expect(own.calls).toEqual([['stop']])
    expect(audited(target.state)).toContainEqual(expect.objectContaining({ tool: 'cli_service', event: 'result', outcome: 'ok', detail: 'stop systemd' }))
    for (const options of [{ installed: { ...installed, thisNode: false } }, { installed: { ...installed, thisNode: null } }, { installed: null }, { installed: { ...installed, thisNode: true }, signals: false, kind: 'task-scheduler' as const }]) {
      const { manager, calls } = fakeManager(target.state, options)
      expect(await service(target, ['stop'], manager)).toEqual({ exitCode: 0, out: 'Buckle is not running.\n', err: '' })
      expect(calls).toEqual([])
    }
  })
})

describe('buckle service status', () => {
  it('says what runs, its health, the running version against the installed one, and what to do next', async () => {
    const target = node()
    writeFileSync(join(target.root, 'package.json'), JSON.stringify({ version: '0.1.5' }))
    const { manager } = fakeManager(target.state, { installed: { node: process.execPath, main: target.main, thisNode: true, enabled: true } })
    const lingering = { ...manager, beforeLogin: async () => ({ starts: false, command: 'loginctl enable-linger owner' }) }
    expect((await service(target, ['status'], lingering)).out).toBe([
      'Service    the imitated definition, starts at login',
      'Running    no',
      'Version    0.1.5 installed',
      'Next       It starts at login. To start it at boot, before anyone logs in, the system\'s own setting is: loginctl enable-linger owner (Buckle does not run it; it may ask for an administrator\'s password).',
      '',
    ].join('\n'))
    const running = await serving(target.state, 'systemd', 900_010)
    try {
      const shown = await service(target, ['status'], { ...manager, beforeLogin: async () => ({ starts: true, command: 'loginctl enable-linger owner' }) })
      expect(shown.out).toContain('Running    yes (pid 900010), started by systemd at 2026-10-16T00:00:00.000Z\nAddress    http://127.0.0.1:4320\nHealth     ')
      expect(shown.out).toContain('Version    0.1.4 running, 0.1.5 installed\nNext       The node runs 0.1.4 and 0.1.5 is installed: run buckle service restart.\n')
      expect(shown.out).not.toContain('enable-linger')
      const json = JSON.parse((await service(target, ['status', '--json'], manager)).out)
      expect(json).toMatchObject({ platform: 'linux', manager: 'systemd', definition: { label: 'the imitated definition', enabled: true, thisNode: true }, running: { pid: 900010, startedBy: 'systemd', address: 'http://127.0.0.1:4320', version: '0.1.4', health: { live: expect.any(Boolean) } }, installedVersion: '0.1.5', next: ['The node runs 0.1.4 and 0.1.5 is installed: run buckle service restart.'] })
    } finally { await running.close() }
  })

  it('says to install again after Node moved, and to start again by hand for a node --background started', async () => {
    const target = node()
    writeFileSync(join(target.root, 'package.json'), JSON.stringify({ version: '0.1.5' }))
    const { manager } = fakeManager(target.state, { installed: { node: join(target.root, 'gone', 'node'), main: target.main, thisNode: true, enabled: false } })
    const running = await serving(target.state, 'background', 900_011)
    try {
      const shown = (await service(target, ['status'], manager)).out
      expect(shown).toContain('Service    the imitated definition, disabled\n')
      expect(shown).toContain('Next       The Buckle service runs a Node binary that is no longer there, as after Node is upgraded or moved; run buckle service install again.\n')
      expect(shown).toContain('Next       The node runs 0.1.4 and 0.1.5 is installed: stop it with buckle service stop, then start it again with buckle serve --background.\n')
    } finally { await running.close() }
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

// The CLI display slice, C6: at a terminal, `buckle service logs` prints what a serve's console prints, in this device's
// local time, with date separators across the lines it prints; piped, or with BUCKLE_LOG_FORMAT=json, the lines as
// stored. The file stays JSON lines in UTC either way.
describe('buckle service logs at a terminal', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const stored = [
    '{"timestamp":"2026-10-21T15:59:59.000Z","level":"info","component":"buckle","message":"5straps Buckle listening","fields":{"port":4320}}',
    '{"n":58}',
    '{"timestamp":"2026-10-21T16:00:01.000Z","level":"warn","component":"buckle","message":"late\\u009bline"}',
    'not a log event',
  ]

  function logged(): Node {
    const target = node()
    mkdirSync(join(target.state, 'logs'))
    writeFileSync(serviceLogPath(target.state), `${stored.join('\n')}\n`)
    return target
  }

  it('renders each stored event as the console does, with date separators, and passes every other line through', async () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    expect((await service(logged(), ['logs'], null, { stdoutIsTerminal: true })).out).toBe([
      '--- 2026-10-21 ---',
      '23:59:59 [info] 5straps Buckle listening port=4320',
      '{"n":58}',
      '--- 2026-10-22 ---',
      '00:00:01 [warn] late\\u009bline',
      'not a log event',
      '',
    ].join('\n'))
  })

  it('prints the lines as stored where BUCKLE_LOG_FORMAT is json, and refuses a format it does not know', async () => {
    const target = logged()
    expect((await service({ ...target, environment: { ...target.environment, BUCKLE_LOG_FORMAT: 'json' } }, ['logs'], null, { stdoutIsTerminal: true })).out).toBe(`${stored.join('\n')}\n`)
    expect(await service({ ...target, environment: { ...target.environment, BUCKLE_LOG_FORMAT: 'pretty' } }, ['logs'], null, { stdoutIsTerminal: true })).toMatchObject({ exitCode: 1, err: 'BUCKLE_LOG_FORMAT must be json or human\n' })
  })

  // Fix brief 1, H7: a line in the logger's shape but for its level or its time is no event, so it passes through, with
  // no separator for a date it does not have.
  it('passes through a stored line with no level, no timestamp, or a timestamp that does not parse', async () => {
    vi.stubEnv('TZ', 'UTC')
    const lines = [
      '{"message":"x"}',
      '{"timestamp":"2026-10-21T14:22:00.000Z","component":"buckle","message":"no level"}',
      '{"level":"info","component":"buckle","message":"no timestamp"}',
      '{"timestamp":"not a time","level":"info","component":"buckle","message":"bad timestamp"}',
    ]
    const target = node()
    mkdirSync(join(target.state, 'logs'))
    writeFileSync(serviceLogPath(target.state), `${lines.join('\n')}\n`)
    const out = (await service(target, ['logs'], null, { stdoutIsTerminal: true })).out
    expect(out).toBe(`${lines.join('\n')}\n`)
    expect(out).not.toContain('NaN')
  })

  it('follows with -f, rendering whole lines as they are added', async () => {
    vi.stubEnv('TZ', 'UTC')
    const target = node()
    mkdirSync(join(target.state, 'logs'))
    const file = serviceLogPath(target.state)
    writeFileSync(file, '')
    const stop = new AbortController()
    let out = ''
    const following = serviceCommand({ argv: ['logs', '-f', '-n', '0'], environment: target.environment, platform: 'linux', cwd: target.root, run: vi.fn(), mainScript: target.main, manager: () => null, out: text => { out += text }, err: () => {}, signal: stop.signal, stdoutIsTerminal: true })
    appendFileSync(file, `${stored[0]}\n{"n":`)
    await vi.waitFor(() => expect(out).toBe('--- 2026-10-21 ---\n15:59:59 [info] 5straps Buckle listening port=4320\n'), { timeout: 5_000 })
    appendFileSync(file, '1}\n')
    await vi.waitFor(() => expect(out).toBe('--- 2026-10-21 ---\n15:59:59 [info] 5straps Buckle listening port=4320\n{"n":1}\n'), { timeout: 5_000 })
    stop.abort()
    expect(await following).toEqual({ exitCode: 0 })
  })

  // Fix brief 1, H5: a reader can catch the node mid-write. The JSON a file stores leaves C1 and bidi characters raw, so a
  // line cut in two, each half no event, reached the terminal raw; the cut line now waits until it is whole.
  const whole = '{"timestamp":"2026-10-21T14:22:00.000Z","level":"info","component":"buckle","message":"5straps Buckle listening","fields":{"port":4320}}'
  const cut = ['{"timestamp":"2026-10-21T14:22:01.000Z","level":"warn","component":"buckle","message":"Could not read",', '"fields":{"path":"/workspace/a\u009b2J\u202etxt"}}']

  function following(target: Node, stdoutIsTerminal: boolean, lines = '0') {
    const stop = new AbortController()
    let out = ''
    const done = serviceCommand({ argv: ['logs', '-f', '-n', lines], environment: target.environment, platform: 'linux', cwd: target.root, run: vi.fn(), mainScript: target.main, manager: () => null, out: text => { out += text }, err: () => {}, signal: stop.signal, stdoutIsTerminal })
    return { out: () => out, stop: async () => { stop.abort(); return done } }
  }

  it('prints a line cut by the node\'s write once, whole, rendered and escaped, never its halves raw', async () => {
    vi.stubEnv('TZ', 'UTC')
    const target = node()
    mkdirSync(join(target.state, 'logs'))
    const file = serviceLogPath(target.state)
    writeFileSync(file, `${whole}\n${cut[0]}`)
    const run = following(target, true)
    await new Promise(resolve => setTimeout(resolve, 600))
    appendFileSync(file, `${cut[1]}\n`)
    await vi.waitFor(() => expect(run.out()).toBe('--- 2026-10-21 ---\n14:22:01 [warn] Could not read path=/workspace/a\\u009b2J\\u202etxt\n'), { timeout: 5_000 })
    expect(await run.stop()).toEqual({ exitCode: 0 })
    expect(run.out()).not.toMatch(/[\u009b\u202e]/)
  })

  it('prints no half of a cut line where piped, and the line as stored once it is whole', async () => {
    const target = node()
    mkdirSync(join(target.state, 'logs'))
    const file = serviceLogPath(target.state)
    writeFileSync(file, `${whole}\n${cut[0]}`)
    expect((await service(target, ['logs'], null)).out).toBe(`${whole}\n`)
    const run = following(target, false)
    await new Promise(resolve => setTimeout(resolve, 600))
    appendFileSync(file, `${cut[1]}\n`)
    await vi.waitFor(() => expect(run.out()).toBe(`${cut.join('')}\n`), { timeout: 5_000 })
    expect(await run.stop()).toEqual({ exitCode: 0 })
  })

  // Fix brief 2, L3: each request leaves two stored lines, `request completed` and `request finished` with an actor, and
  // the console shows the first alone, so -n counted the second against the rows asked for.
  describe('-n', () => {
    const stamp = (second: number, day: number) => `2026-10-${day}T14:22:${String(second).padStart(2, '0')}.000Z`
    const completed = (second: number, day = 21) => `{"timestamp":"${stamp(second, day)}","level":"info","component":"buckle","message":"request completed","fields":{"method":"POST","path":"/mcp","outcome":"ok","durationMs":${second}}}`
    const finished = (second: number, day = 21) => `{"timestamp":"${stamp(second, day)}","level":"info","component":"buckle","message":"request finished","fields":{"method":"POST","route":"/mcp","status":200,"durationMs":${second},"actor":"agent:node","workspaceId":"w-1"}}`
    const request = (second: number, day = 21) => [completed(second, day), finished(second, day)]
    const row = (second: number) => `14:22:${String(second).padStart(2, '0')} [info] /mcp request completed (${second}ms)`

    function written(lines: string[]): Node {
      const target = node()
      mkdirSync(join(target.state, 'logs'))
      writeFileSync(serviceLogPath(target.state), `${lines.join('\n')}\n`)
      return target
    }

    const sixty = Array.from({ length: 60 }, (_, second) => request(second)).flat()
    const terminal = { stdoutIsTerminal: true }

    it('counts the entries a terminal shows: as many rows as asked for, 50 by default', async () => {
      vi.stubEnv('TZ', 'UTC')
      const target = written(sixty)
      expect((await service(target, ['logs', '-n', '10'], null, terminal)).out).toBe(['--- 2026-10-21 ---', ...Array.from({ length: 10 }, (_, index) => row(50 + index)), ''].join('\n'))
      const fifty = (await service(target, ['logs'], null, terminal)).out.split('\n').filter(Boolean)
      expect(fifty).toHaveLength(51)
      expect(fifty.slice(0, 2)).toEqual(['--- 2026-10-21 ---', row(10)])
    })

    it('counts stored lines where the output is piped, or BUCKLE_LOG_FORMAT is json', async () => {
      const target = written(sixty)
      const lastTen = `${sixty.slice(-10).join('\n')}\n`
      expect((await service(target, ['logs', '-n', '10'], null)).out).toBe(lastTen)
      expect((await service({ ...target, environment: { ...target.environment, BUCKLE_LOG_FORMAT: 'json' } }, ['logs', '-n', '10'], null, terminal)).out).toBe(lastTen)
    })

    it('runs the date separators over the entries it prints alone', async () => {
      vi.stubEnv('TZ', 'UTC')
      const target = written([...request(1, 20), ...request(2), ...request(3)])
      expect((await service(target, ['logs', '-n', '3'], null, terminal)).out).toBe(['--- 2026-10-20 ---', row(1), '--- 2026-10-21 ---', row(2), row(3), ''].join('\n'))
      expect((await service(target, ['logs', '-n', '2'], null, terminal)).out).toBe(['--- 2026-10-21 ---', row(2), row(3), ''].join('\n'))
    })

    it('counts a line that is no event as one entry, and -n 0 prints nothing', async () => {
      vi.stubEnv('TZ', 'UTC')
      const target = written([...request(1), 'not a log event', ...request(2)])
      expect((await service(target, ['logs', '-n', '2'], null, terminal)).out).toBe(['not a log event', '--- 2026-10-21 ---', row(2), ''].join('\n'))
      expect((await service(target, ['logs', '-n', '0'], null, terminal)).out).toBe('')
    })

    it('leaves -f as it was: the last entries first, then what the file gains, under the same separator', async () => {
      vi.stubEnv('TZ', 'UTC')
      const target = written([...request(1), ...request(2)])
      const run = following(target, true, '1')
      await vi.waitFor(() => expect(run.out()).toBe(`--- 2026-10-21 ---\n${row(2)}\n`), { timeout: 5_000 })
      appendFileSync(serviceLogPath(target.state), `${request(3).join('\n')}\n`)
      await vi.waitFor(() => expect(run.out()).toBe(`--- 2026-10-21 ---\n${row(2)}\n${row(3)}\n`), { timeout: 5_000 })
      expect(await run.stop()).toEqual({ exitCode: 0 })
    })
  })
})
