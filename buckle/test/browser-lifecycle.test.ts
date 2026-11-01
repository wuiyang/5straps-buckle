import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import type { ToolContext } from '../common/domain/tool.js'
import { createBrowserPack, type BrowserPackOptions } from '../common/services/packs/browser/index.js'
import type { BrowserMode } from '../common/services/packs/browser/mode.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'

// Slice F4 (browser lifecycle, owner's Windows report of 2026-11-02). The agent-browser here is a stand-in that keeps
// 0.41.1's daemon rules (cli/src/main.rs, connection.rs, native/actions.rs), as the investigation's reproduction does:
// - every invocation ensures a daemon for its --session, close included;
// - --allowed-domains, --headed, or --args makes the CLI send `launch` first, which starts a browser where the daemon
//   holds none;
// - any other command starts one where none runs; close never does, and ends the daemon;
// - an idle timeout ends a daemon and its browser, which Buckle never learns.

interface StandIn {
  /** The browsers each call started, counted per Buckle call. */
  launches: number
  /** The sessions whose daemon holds a browser now. */
  alive(): string[]
  /** As an idle timeout does: every daemon and its browser end, and Buckle is not told. */
  idleOut(): void
  calls: ProcessRequest[]
  run(request: ProcessRequest): Promise<ProcessResult>
}

function standIn(): StandIn {
  const daemons = new Map<string, { browser: boolean }>()
  const state: StandIn = {
    launches: 0,
    alive: () => [...daemons].filter(([, daemon]) => daemon.browser).map(([name]) => name),
    idleOut: () => daemons.clear(),
    calls: [],
    run: async (request) => {
      state.calls.push(request)
      const args = request.args
      const session = args[args.indexOf('--session') + 1]!
      const command = args[0]!
      let daemon = daemons.get(session)
      if (!daemon) daemons.set(session, daemon = { browser: false })
      const launch = () => { if (!daemon.browser) { daemon.browser = true; state.launches++ } }
      if (args.includes('--allowed-domains') || args.includes('--headed') || args.includes('--args')) launch()
      if (command === 'close') {
        daemons.delete(session)
        return result({ success: true, data: { closed: true } })
      }
      launch()
      return result({ success: true, data: {} })
    },
  }
  return state
}

function result(body: unknown): ProcessResult {
  return { exitCode: 0, signal: null, stdout: JSON.stringify(body), stderr: '', truncated: false, timedOut: false }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function node(options: { mode?: BrowserMode } & Partial<BrowserPackOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-browser-lifecycle-'))
  roots.push(root)
  const browser = standIn()
  const sessionDirectory = join(root, 'state')
  const open = (overrides: Partial<BrowserPackOptions> = {}) => createBrowserPack({
    cwd: root, paths: createPathView({ root, mount: null }), sessionDirectory, agentBrowserCommand: 'agent-browser',
    agentBrowser: { path: 'agent-browser', argv0: 'agent-browser', args: [] }, headed: false,
    approvedLists: [{ name: 'workspace', entries: ['app.example.test'] }], browser: { mode: options.mode ?? { kind: 'fresh' } },
    runProcess: request => browser.run(request), ...options, ...overrides,
  })
  return { root, browser, sessionDirectory, open, stored: () => JSON.parse(readFileSync(join(sessionDirectory, 'sessions.json'), 'utf8')) as Record<string, unknown> }
}

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({ requestId: 'r', sessionId: 'mcp', timeoutMs: 1000, signal: new AbortController().signal, ...overrides })

async function call(pack: ReturnType<ReturnType<typeof node>['open']>, input: Record<string, unknown>, overrides: Partial<ToolContext> = {}) {
  return pack.tools[0]!.prepare(input as never).execute(context(overrides)) as Promise<{ result?: unknown; notice?: string }>
}

/** What each call launched, as the stand-in counts it. */
async function launchesOf(browser: StandIn, run: () => Promise<unknown>): Promise<number> {
  const before = browser.launches
  await run()
  return browser.launches - before
}

const LAUNCH_FLAGS = ['--allowed-domains', '--headed', '--args', '--idle-timeout', '--cdp', '--profile']

describe('a close (F4 item 2)', () => {
  it.each<[string, BrowserMode]>([
    ['a fresh browser', { kind: 'fresh' }],
    ['a profile folder', { kind: 'profile', directory: '/owner/profile' }],
    ['an attached Chrome', { kind: 'attached', endpoint: '9222' }],
  ])('on %s passes only --config and --session, so agent-browser never launches to close', async (_, mode) => {
    const { browser, open, sessionDirectory } = node({ mode, headed: true, launchArgs: '--lang=en-GB' })
    const pack = open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] })
    const session = browser.calls.at(-1)!.args[browser.calls.at(-1)!.args.indexOf('--session') + 1]
    await call(pack, { command: 'close' })
    expect(browser.calls.at(-1)!.args).toEqual(['close', '--json', '--config', join(sessionDirectory, 'fresh-config.json'), '--session', session])
    for (const flag of LAUNCH_FLAGS) expect(browser.calls.at(-1)!.args).not.toContain(flag)
  })

  it('launches nothing when the daemon idled out before it', async () => {
    const { browser, open } = node({ headed: true })
    const pack = open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] })
    browser.idleOut()
    expect(await launchesOf(browser, () => call(pack, { command: 'close' }))).toBe(0)
    expect(browser.alive()).toEqual([])
  })

  it('runs nothing for a caller with no browser recorded, and says no browser was open', async () => {
    const { browser, open } = node()
    const pack = open()
    const answer = await call(pack, { command: 'close' })
    expect(browser.calls).toEqual([])
    expect(answer).toEqual({ result: { success: true, data: { closed: false } }, stderr: '', truncated: false, notice: 'No browser was open for this session, so nothing was closed.' })
    // Another caller's browser is not this caller's to close.
    await call(pack, { command: 'open', args: ['https://app.example.test/'] }, { sessionId: 'other-agent' })
    expect((await call(pack, { command: 'close' })).notice).toBe('No browser was open for this session, so nothing was closed.')
    expect(browser.alive()).toHaveLength(1)
  })

  it('takes no arguments of the agent\'s, as close --all would end every agent-browser session on the machine', () => {
    const { browser, open } = node()
    const pack = open()
    for (const args of [['--all'], ['--headed'], ['tab']]) {
      expect(() => pack.tools[0]!.prepare({ command: 'close', args })).toThrow('close takes no arguments: it ends this session\'s browser alone')
    }
    expect(browser.calls).toEqual([])
  })
})

/** The sessions the store records for a caller, by their key fields, whatever the store's shape. */
function recordedFor(stored: Record<string, unknown>, caller: string): Array<{ name: string; stage: string; alias: string }> {
  const browsers = (stored.browsers ?? {}) as Record<string, { caller: string; stage: string; alias: string }>
  return Object.entries(browsers).filter(([, record]) => record.caller === caller).map(([name, record]) => ({ name, stage: record.stage, alias: record.alias }))
}

const sessionOf = (request: ProcessRequest) => request.args[request.args.indexOf('--session') + 1]!

describe('the key a browser session is kept under (F4 item 3)', () => {
  it('keeps one browser across a caller\'s turns, and gives each stage and alias its own, as Rings stages never share a page', async () => {
    const { browser, open } = node()
    const pack = open()
    expect(await launchesOf(browser, () => call(pack, { command: 'open', args: ['https://app.example.test/'] }))).toBe(1)
    expect(await launchesOf(browser, () => call(pack, { command: 'snapshot', args: ['-i'] }))).toBe(0)
    expect(await launchesOf(browser, () => call(pack, { command: 'click', args: ['@e3'] }))).toBe(0)
    expect(await launchesOf(browser, () => call(pack, { command: 'snapshot' }, { stageId: 'turn-2' }))).toBe(1)
    expect(await launchesOf(browser, () => call(pack, { command: 'snapshot', session: 'checkout' }))).toBe(1)
    expect(browser.alive()).toHaveLength(3)
  })

  it.each<[string, Partial<BrowserPackOptions>]>([
    ['a window', { headed: true }],
    ['other arguments', { launchArgs: '--lang=en-GB' }],
    ['another idle timeout', { idleTimeoutMs: 120_000 }],
    ['an attached Chrome', { browser: { mode: { kind: 'attached', endpoint: '9222' } } }],
  ])('replaces the session under the same key when the node now runs %s, and keeps no record under the old settings', async (_, changed) => {
    const { browser, open, stored } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] }, { stageId: 'turn-2' })
    const first = sessionOf(browser.calls[0]!)
    await call(open(changed), { command: 'snapshot' }, { stageId: 'turn-2' })
    expect(browser.calls.map(request => request.args[0])).toEqual(['open', 'close', 'snapshot'])
    expect(sessionOf(browser.calls[1]!)).toBe(first)
    const second = sessionOf(browser.calls[2]!)
    expect(second).not.toBe(first)
    expect(browser.alive()).toEqual([second])
    expect(recordedFor(stored(), 'mcp')).toEqual([{ name: second, stage: 'turn-2', alias: 'default' }])
    // A close from the same caller and stage reaches it, and leaves nothing behind.
    await call(open(changed), { command: 'close' }, { stageId: 'turn-2' })
    expect(browser.alive()).toEqual([])
    expect(recordedFor(stored(), 'mcp')).toEqual([])
  })

  it('leaves a live sibling process\'s browser from other settings running, and starts this process\'s own beside it', async () => {
    const { browser, open, stored, sessionDirectory } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] })
    const sibling = sessionOf(browser.calls[0]!)
    writtenBy(sessionDirectory, process.ppid)
    await call(open({ headed: true }), { command: 'snapshot' })
    expect(browser.calls.map(request => request.args[0])).toEqual(['open', 'snapshot'])
    const own = sessionOf(browser.calls[1]!)
    expect(own).not.toBe(sibling)
    expect(recordedFor(stored(), 'mcp').map(record => record.name).sort()).toEqual([own, sibling].sort())
    // Each process reaches its own: a call under the sibling's settings finds its browser, and this process's window,
    // from settings it no longer runs, is replaced first.
    await call(open(), { command: 'snapshot' })
    expect(browser.calls.slice(2).map(request => [request.args[0], sessionOf(request)])).toEqual([['close', own], ['snapshot', sibling]])
  })
})

/** Marks every record in the store as written by `pid`, as another Buckle process would have left it. */
function writtenBy(sessionDirectory: string, pid: number): void {
  const file = join(sessionDirectory, 'sessions.json')
  const state = JSON.parse(readFileSync(file, 'utf8')) as { browsers?: Record<string, { writer: { pid: number; instance: string } }> }
  for (const record of Object.values(state.browsers ?? {})) record.writer = { pid, instance: 'another-process' }
  writeFileSync(file, JSON.stringify(state))
}

/** A pid no process holds: one that ran and ended. */
function stoppedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!
}

/** Rewrites the records the store holds, as another process, a stop, or the clock would have left them. */
function rewrite(sessionDirectory: string, change: (record: Record<string, unknown>, name: string) => void): void {
  const file = join(sessionDirectory, 'sessions.json')
  const state = JSON.parse(readFileSync(file, 'utf8')) as { browsers: Record<string, Record<string, unknown>> }
  for (const [name, record] of Object.entries(state.browsers)) change(record, name)
  writeFileSync(file, JSON.stringify(state))
}

describe('no browser outlives its session (F4 item 4)', () => {
  it('ends at pack start every browser a stopped process left: a bare close, then its record goes', async () => {
    const { browser, open, stored, sessionDirectory } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] })
    await call(open(), { command: 'snapshot' }, { stageId: 'turn-2' })
    const left = browser.alive()
    rewrite(sessionDirectory, record => { record.writer = { pid: stoppedPid(), instance: 'stopped' } })
    const restarted = open()
    await vi.waitFor(() => expect(browser.alive()).toEqual([]))
    expect(browser.calls.slice(2).map(request => [request.args[0], sessionOf(request)]).sort()).toEqual(left.map(name => ['close', name]).sort())
    for (const request of browser.calls.slice(2)) for (const flag of LAUNCH_FLAGS) expect(request.args).not.toContain(flag)
    await vi.waitFor(() => expect(stored().browsers).toEqual({}))
    // The caller's next call starts a browser of its own, under a new name.
    expect(await launchesOf(browser, () => call(restarted, { command: 'snapshot' }))).toBe(1)
    expect(left).not.toContain(browser.alive()[0])
  })

  it('ends one a process of this pid wrote under an instance that no longer runs, as a pid can come back', async () => {
    const { browser, open, sessionDirectory } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] })
    rewrite(sessionDirectory, record => { record.writer = { pid: process.pid, instance: 'an-earlier-process' } })
    open()
    await vi.waitFor(() => expect(browser.alive()).toEqual([]))
  })

  it('leaves a live sibling\'s browser at start', async () => {
    const { browser, open, sessionDirectory } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] })
    writtenBy(sessionDirectory, process.ppid)
    const pack = open()
    await call(pack, { command: 'snapshot' }, { sessionId: 'other-agent' })
    expect(browser.calls.map(request => request.args[0])).toEqual(['open', 'snapshot'])
    expect(browser.alive()).toHaveLength(2)
  })

  it('ends, before the next call, a browser whose last use is past its idle timeout, and launches nothing to close it', async () => {
    const { browser, open, stored, sessionDirectory } = node({ idleTimeoutMs: 60_000, maxTimeoutMs: 60_000 })
    const pack = open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] }, { sessionId: 'idle-agent' })
    const idle = sessionOf(browser.calls[0]!)
    rewrite(sessionDirectory, (record) => { record.usedAt = Date.now() - 121_000 })
    browser.idleOut()
    expect(await launchesOf(browser, () => call(pack, { command: 'snapshot' }))).toBe(1)
    expect(browser.calls.map(request => [request.args[0], sessionOf(request) === idle])).toEqual([['open', true], ['close', true], ['snapshot', false]])
    expect(Object.keys(stored().browsers as object)).toEqual([sessionOf(browser.calls[2]!)])
  })

  it('keeps one still within its idle timeout and the longest call', async () => {
    const { browser, open, sessionDirectory } = node({ idleTimeoutMs: 60_000, maxTimeoutMs: 60_000 })
    const pack = open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] }, { sessionId: 'busy-agent' })
    rewrite(sessionDirectory, (record) => { record.usedAt = Date.now() - 110_000 })
    await call(pack, { command: 'snapshot' })
    expect(browser.calls.map(request => request.args[0])).toEqual(['open', 'snapshot'])
  })

  it('closes at shutdown every browser this process wrote, a profile folder\'s included, and leaves a sibling\'s', async () => {
    const profile = node({ mode: { kind: 'profile', directory: '/owner/profile' } })
    const pack = profile.open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] })
    await pack.close?.()
    expect(profile.browser.calls.map(request => request.args[0])).toEqual(['open', 'close'])
    expect(profile.browser.alive()).toEqual([])
    expect(profile.stored().browsers).toEqual({})

    const fresh = node()
    const first = fresh.open()
    await call(first, { command: 'open', args: ['https://app.example.test/'] })
    writtenBy(fresh.sessionDirectory, process.ppid)
    const second = fresh.open()
    await call(second, { command: 'open', args: ['https://app.example.test/'] }, { sessionId: 'second-agent' })
    await second.close?.()
    expect(fresh.browser.alive()).toEqual([sessionOf(fresh.browser.calls[0]!)])
  })

  it('marks a browser whose close failed as closing, and the next start ends it', async () => {
    const { browser, open, stored } = node()
    const pack = open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] })
    const session = sessionOf(browser.calls[0]!)
    const run = browser.run
    browser.run = async request => request.args[0] === 'close' ? { ...result({ success: false }), exitCode: 1 } : run(request)
    await pack.close?.()
    expect((stored().browsers as Record<string, { closing?: boolean }>)[session]).toMatchObject({ closing: true })
    browser.run = run
    open()
    await vi.waitFor(() => expect(stored().browsers).toEqual({}))
    expect(browser.alive()).toEqual([])
  })

  it('ends the browsers an earlier Buckle recorded, at the first start after the upgrade', async () => {
    const { browser, open, sessionDirectory, stored } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] })
    const session = sessionOf(browser.calls[0]!)
    const fingerprint = (stored().browsers as Record<string, { mode: string }>)[session]!.mode
    const key = JSON.stringify(['fresh', fingerprint, 'mcp', 'default', 'default'])
    writeFileSync(join(sessionDirectory, 'sessions.json'), JSON.stringify({ sessions: { [key]: session }, allowedDomains: { [key]: 'app.example.test' }, modes: { [key]: fingerprint }, writers: { [key]: process.pid } }))
    open()
    await vi.waitFor(() => expect(browser.alive()).toEqual([]))
    expect(stored()).toEqual({ browsers: {}, sessions: {}, allowedDomains: {}, modes: {}, writers: {} })
  })
})

const FILL = { secretFills: [{ real: '/workspace/.env.local', written: '.env.local', name: 'LOGIN_PASSWORD', digest: 'd'.repeat(64) }] }

/** The values a call of this context is masked by, by NAME. */
async function heldFor(pack: ReturnType<ReturnType<typeof node>['open']>, overrides: Partial<ToolContext> = {}, args: Record<string, unknown> = { command: 'snapshot', args: [] }): Promise<string[]> {
  return (await pack.filled!.list({ context: context(overrides), args: args as never })).map(entry => entry.name)
}

describe('the hold a fill leaves, per browser (F4 item 5)', () => {
  it('masks a fresh browser\'s calls by its own fills alone, never another caller\'s, stage\'s, or alias\'s', async () => {
    const { open } = node()
    const pack = open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    expect(await heldFor(pack)).toEqual(['LOGIN_PASSWORD'])
    expect(await heldFor(pack, { sessionId: 'other-agent' })).toEqual([])
    expect(await heldFor(pack, { stageId: 'turn-2' })).toEqual([])
    expect(await heldFor(pack, {}, { command: 'snapshot', args: [], session: 'checkout' })).toEqual([])
  })

  // Each ends the default caller's browser alone; the other caller's keeps its hold.
  const mine = (record: Record<string, unknown>) => record.caller === 'mcp'
  it.each<[string, (pack: ReturnType<ReturnType<typeof node>['open']>, tools: ReturnType<typeof node>) => Promise<unknown>]>([
    ['its close', pack => call(pack, { command: 'close' })],
    ['its idle timeout', async (pack, { sessionDirectory }) => { rewrite(sessionDirectory, (record) => { if (mine(record)) record.usedAt = 0 }); await call(pack, { command: 'snapshot' }, { sessionId: 'other-agent' }) }],
    ['the start after its process stopped', async (_, { sessionDirectory }) => { rewrite(sessionDirectory, (record) => { record.writer = mine(record) ? { pid: stoppedPid(), instance: 'stopped' } : { pid: process.ppid, instance: 'live-sibling' } }) }],
    ['its process\'s shutdown', async (pack, { sessionDirectory }) => { rewrite(sessionDirectory, (record) => { if (!mine(record)) record.writer = { pid: process.ppid, instance: 'live-sibling' } }); await pack.close!() }],
  ])('drops a fresh browser\'s hold with the browser, at %s, and leaves another browser\'s', async (_, end) => {
    const tools = node()
    const pack = tools.open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, { sessionId: 'other-agent', ...FILL })
    await end(pack, tools)
    const after = tools.open()
    await vi.waitFor(async () => expect(await heldFor(after)).toEqual([]))
    expect(await heldFor(after, { sessionId: 'other-agent' })).toEqual(['LOGIN_PASSWORD'])
  })

  it('masks every call on a profile folder by the shared browser\'s fills, and drops them when that browser ends', async () => {
    const { open } = node({ mode: { kind: 'profile', directory: '/owner/profile' } })
    const pack = open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    expect(await heldFor(pack, { sessionId: 'other-agent', stageId: 'turn-2' })).toEqual(['LOGIN_PASSWORD'])
    await call(pack, { command: 'close' }, { sessionId: 'other-agent' })
    expect(await heldFor(pack)).toEqual([])
  })

  it('keeps an attached Chrome\'s hold through close, shutdown, and a restart, as it keeps its pages', async () => {
    const { open, sessionDirectory } = node({ mode: { kind: 'attached', endpoint: '9222' } })
    const pack = open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    expect(await heldFor(pack, { sessionId: 'other-agent' })).toEqual(['LOGIN_PASSWORD'])
    await call(pack, { command: 'close' })
    await pack.close?.()
    const restarted = open()
    expect(await heldFor(restarted)).toEqual(['LOGIN_PASSWORD'])
    expect(JSON.parse(readFileSync(join(sessionDirectory, 'sessions.json'), 'utf8')).browsers).toEqual({})
  })

  it('spreads an earlier Buckle\'s workspace-wide hold over the browsers it recorded, which end with them', async () => {
    const { browser, open, sessionDirectory } = node()
    await call(open(), { command: 'open', args: ['https://app.example.test/'] })
    const session = sessionOf(browser.calls[0]!)
    const key = JSON.stringify(['fresh', 'old-fingerprint', 'mcp', 'default', 'default'])
    writeFileSync(join(sessionDirectory, 'sessions.json'), JSON.stringify({ sessions: { [key]: session }, modes: { [key]: 'old-fingerprint' }, writers: { [key]: process.pid }, filled: FILL.secretFills }))
    const restarted = open()
    expect(await heldFor(restarted)).toEqual([])
    expect(browser.alive()).toEqual([])
  })
})

describe('the owner\'s buckle browser close (F4 item 6)', () => {
  it('closes every recorded browser of the workspace, a live sibling\'s and one a close failed for included, and forgets every record and hold', async () => {
    const { browser, open, sessionDirectory, stored } = node()
    const pack = open()
    await call(pack, { command: 'open', args: ['https://app.example.test/'] })
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, { sessionId: 'second-agent', ...FILL })
    await call(pack, { command: 'open', args: ['https://app.example.test/'] }, { sessionId: 'sibling-agent' })
    rewrite(sessionDirectory, (record) => {
      if (record.caller === 'sibling-agent') record.writer = { pid: process.ppid, instance: 'live-sibling' }
      if (record.caller === 'mcp') record.closing = true
    })
    const file = join(sessionDirectory, 'sessions.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), attached: [{ ...FILL.secretFills[0], name: 'CHROME_PASSWORD' }] }))
    const before = browser.alive()
    const counts = await pack.closeBrowsers!()
    expect(counts).toEqual({ browsers: 3, closed: 3, held: 2 })
    expect(browser.calls.slice(3).map(request => sessionOf(request)).sort()).toEqual([...before].sort())
    for (const request of browser.calls.slice(3)) expect(request.args).toEqual(['close', '--json', '--config', join(sessionDirectory, 'fresh-config.json'), '--session', sessionOf(request)])
    expect(browser.alive()).toEqual([])
    expect(stored()).toEqual({ browsers: {}, sessions: {}, allowedDomains: {}, modes: {}, writers: {} })
    expect(await heldFor(pack, { sessionId: 'second-agent' })).toEqual([])
  })

  it('closes them in parallel under one bound, holding the sessions lock, so no call starts a browser meanwhile', async () => {
    const { browser, open } = node()
    const pack = open()
    for (const agent of ['a', 'b', 'c']) await call(pack, { command: 'open', args: ['https://app.example.test/'] }, { sessionId: agent })
    const run = browser.run
    let inFlight = 0
    let most = 0
    browser.run = async (request) => {
      if (request.args[0] !== 'close') return run(request)
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(resolve => setTimeout(resolve, 150))
      inFlight--
      return run(request)
    }
    const closing = pack.closeBrowsers!()
    await new Promise(resolve => setTimeout(resolve, 20))
    const later = call(pack, { command: 'snapshot' }, { sessionId: 'a' })
    expect(await closing).toEqual({ browsers: 3, closed: 3, held: 0 })
    await later
    expect(most).toBe(3)
    expect(browser.calls.at(-1)!.args[0]).toBe('snapshot')
    expect(browser.alive()).toEqual([sessionOf(browser.calls.at(-1)!)])
  })

  // Codex review L1: a profile folder's browser keeps its name, so one that did not close, forgotten, was reached again
  // with no hold, and its page showed the value.
  it('keeps a browser whose close failed, marked closing with its hold, so the next call is masked, and a later run ends it', async () => {
    const { browser, open, stored } = node({ mode: { kind: 'profile', directory: '/owner/profile' } })
    const pack = open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    const session = sessionOf(browser.calls[0]!)
    const run = browser.run
    browser.run = async request => request.args[0] === 'close' ? { ...result({ success: false }), exitCode: 1 } : run(request)
    expect(await pack.closeBrowsers!()).toEqual({ browsers: 1, closed: 0, held: 0, kept: 1 })
    expect((stored().browsers as Record<string, unknown>)[session]).toMatchObject({ closing: true, held: [expect.objectContaining({ name: 'LOGIN_PASSWORD' })] })
    expect(await heldFor(pack, { sessionId: 'other-agent' })).toEqual(['LOGIN_PASSWORD'])
    browser.run = run
    expect(await pack.closeBrowsers!()).toEqual({ browsers: 1, closed: 1, held: 1 })
    expect(stored().browsers).toEqual({})
  })
})

describe('the browsers a refusal names (F4 item 7)', () => {
  it('names each browser that holds a value, its caller, alias, stage, and last use, and the command that ends it', async () => {
    const { open } = node({ workspaceName: () => 'the site' })
    const pack = open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'], session: 'checkout' }, { stageId: 'turn-2', ...FILL })
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, { sessionId: 'other-agent', ...FILL })
    const [held] = await pack.filled!.list({ context: context({ stageId: 'turn-2' }), args: { command: 'snapshot', args: [], session: 'checkout' } })
    expect(held!.holders).toEqual([
      expect.stringMatching(/^the fresh browser of caller mcp, session checkout, stage turn-2, last used \d{4}-\d{2}-\d{2}T[\d:.]+Z, which browser_command close with session checkout from that caller and stage ends$/),
      expect.stringMatching(/^the fresh browser of caller other-agent, last used \d{4}-\d{2}-\d{2}T[\d:.]+Z, which browser_command close from that caller ends$/),
    ])
    expect(held!.ownerCommand).toBe('buckle browser close --workspace \'the site\'')
  })

  it('names a profile folder\'s browser and an attached Chrome as every caller\'s', async () => {
    const profile = node({ mode: { kind: 'profile', directory: '/owner/profile' }, workspaceName: () => 'site' })
    const pack = profile.open()
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    const [shared] = await pack.filled!.list({ context: context({ sessionId: 'other-agent' }), args: { command: 'snapshot', args: [] } })
    expect(shared!.holders).toEqual([expect.stringMatching(/^the profile folder's browser, which every caller shares, last used \S+, which browser_command close from any caller ends$/)])
    const attached = node({ mode: { kind: 'attached', endpoint: '9222' }, workspaceName: () => 'site' })
    const chrome = attached.open()
    await call(chrome, { command: 'fill', args: ['@e5', 'x'] }, FILL)
    const [owners] = await chrome.filled!.list({ context: context(), args: { command: 'snapshot', args: [] } })
    expect(owners!.holders).toEqual(['the owner\'s attached Chrome, which keeps its pages through a close, so only the owner\'s command ends its hold'])
    expect(owners!.ownerCommand).toBe('buckle browser close --workspace site')
  })
})

describe('the most values one browser holds', () => {
  it('refuses a fill past 256 values in one browser, naming the closes that end it, and leaves other browsers free', async () => {
    const { open } = node({ workspaceName: () => 'site' })
    const pack = open()
    const fills = (count: number, from = 0) => ({ secretFills: Array.from({ length: count }, (_, index) => ({ ...FILL.secretFills[0]!, name: `VALUE_${from + index}` })) })
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, fills(256))
    await expect(call(pack, { command: 'fill', args: ['@e5', 'x'] }, fills(1, 256))).rejects.toThrow('A browser is masked by at most 256 filled secret values; end it with browser_command close, or the owner\'s buckle browser close --workspace site, to fill more')
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, fills(1))
    await call(pack, { command: 'fill', args: ['@e5', 'x'] }, { sessionId: 'other-agent', ...fills(1, 256) })
  })
})
