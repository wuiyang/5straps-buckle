import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
