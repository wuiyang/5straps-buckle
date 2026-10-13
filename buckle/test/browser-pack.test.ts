import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@5straps/protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { browserEffects, refusedFlag } from '../common/services/packs/browser/effects.js'
import { createPathView } from '../common/domain/path-view.js'
import { createBrowserPack, type BrowserPackOptions } from '../common/services/packs/browser/index.js'
import type { BrowserMode } from '../common/services/packs/browser/mode.js'
import { loadPackSkill } from '../common/services/packs/pack-skill.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createNetworkEgressRule } from '../common/domain/permission/rules/network-egress-rule.js'
import { ToolInputError, type ToolContext } from '../common/domain/tool.js'
import { compileUrlPatterns } from '../common/domain/url-pattern.js'

const PROFILE = mkdtempSync('/tmp/buckle-browser-pack-')
afterAll(() => rmSync(PROFILE, { recursive: true, force: true }))

function stubResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false, ...overrides }
}

async function run(input: JsonObject, options: Partial<BrowserPackOptions> = {}, result = stubResult()) {
  const calls: ProcessRequest[] = []
  const pack = createBrowserPack({
    cwd: '/work',
    paths: createPathView({ root: '/work', mount: null }),
    agentBrowserCommand: 'agent-browser',
    sessionDirectory: PROFILE,
    headed: false,
    agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' },
    approvedLists: [],
    runProcess: async request => {
      calls.push(request)
      return result
    },
    ...options,
  })

  const tool = pack.tools[0]
  if (!tool) throw new Error('the browser pack registered no tool')
  const output = await tool.prepare(input).execute({
    requestId: 'r1',
    sessionId: 's1',
    timeoutMs: 1000,
    signal: new AbortController().signal,
  })
  // The command's own call is the last: a session left under other settings is closed before it.
  return { args: calls.at(-1)?.args ?? [], output }
}

describe('the arguments the browser pack builds', () => {
  it('puts the subcommand first and its positionals next, which is the order agent-browser wants', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args.slice(0, 2)).toEqual(['open', 'https://example.com/'])
  })

  it('always asks for JSON, so output can be parsed rather than scraped', async () => {
    const { args } = await run({ command: 'snapshot', args: ['-i'] })
    expect(args).toContain('--json')
  })

  it('runs headless by default, because a node usually has no display', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args).not.toContain('--headed')
  })

  it('shows a window when the operator configured one', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] }, { headed: true })
    expect(args).toContain('--headed')
  })

  it('lets a per-call flag override the configured default, rather than passing it twice', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com', '--headed', 'false'] }, { headed: true })
    expect(args.filter(argument => argument === '--headed')).toHaveLength(1)
    expect(args.slice(0, 5)).toEqual(['open', 'https://example.com/', '--headed', 'false', '--json'])
  })

  it('passes a session through as a flag, keeping browser state isolated per caller', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'], session: 'tester' })
    expect(args[args.indexOf('--session') + 1]).toMatch(/^buckle-/)
    expect(args).not.toContain('tester')
  })
})

describe('the browser the owner\'s settings choose', () => {
  const PROFILE_MODE: BrowserMode = { kind: 'profile', directory: '/owner/browser-profile' }
  const ATTACHED: BrowserMode = { kind: 'attached', endpoint: 'ws://127.0.0.1:9222/devtools/browser/abc' }
  const approved = [{ name: 'workspace' as const, entries: ['example.com'] }]
  const valueOf = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
  const freshDirectory = () => mkdtempSync(join(tmpdir(), 'buckle-browser-mode-'))

  it('holds a fresh browser to the approved hosts and passes the owner\'s arguments with them', async () => {
    const { args } = await run({ command: 'snapshot', args: [] }, { approvedLists: approved, launchArgs: '--disable-blink-features=AutomationControlled' })
    expect(valueOf(args, '--allowed-domains')).toBe('example.com')
    expect(valueOf(args, '--args')).toBe('--disable-blink-features=AutomationControlled')
    expect(valueOf(args, '--idle-timeout')).toBe('300000')
    expect(args).not.toContain('--profile')
    expect(args).not.toContain('--cdp')
  })

  // With no setting the argv is the one Buckle passed before the owner could choose a browser, flag for flag.
  it('hands a fresh browser the whole argv it always had, with and without a list or a window', async () => {
    const directory = freshDirectory()
    const config = join(directory, 'fresh-config.json')
    const session = expect.stringMatching(/^buckle-[0-9a-f-]{36}$/)
    expect((await run({ command: 'snapshot', args: [] }, { sessionDirectory: directory, approvedLists: approved })).args)
      .toEqual(['snapshot', '--json', '--config', config, '--session', session, '--idle-timeout', '300000', '--allowed-domains', 'example.com'])
    expect((await run({ command: 'open', args: ['example.com'] }, { sessionDirectory: directory, approvedLists: approved })).args)
      .toEqual(['open', 'https://example.com/', '--json', '--config', config, '--session', session, '--idle-timeout', '300000', '--allowed-domains', 'example.com'])
    const other = freshDirectory()
    expect((await run({ command: 'snapshot', args: [] }, { sessionDirectory: other })).args)
      .toEqual(['snapshot', '--json', '--config', join(other, 'fresh-config.json'), '--session', session, '--idle-timeout', '300000'])
    const headed = freshDirectory()
    expect((await run({ command: 'snapshot', args: [] }, { sessionDirectory: headed, headed: true, approvedLists: approved })).args)
      .toEqual(['snapshot', '--json', '--config', join(headed, 'fresh-config.json'), '--session', session, '--idle-timeout', '300000', '--allowed-domains', 'example.com', '--headed'])
    for (const folder of [directory, other, headed]) rmSync(folder, { recursive: true, force: true })
  })

  it('passes no --args when the owner set none', async () => {
    const { args } = await run({ command: 'snapshot', args: [] })
    expect(args).not.toContain('--args')
  })

  it('launches a profile folder with its arguments and window, and never with --allowed-domains, which agent-browser refuses there', async () => {
    const { args } = await run({ command: 'snapshot', args: [] }, { browser: { mode: PROFILE_MODE }, approvedLists: approved, headed: true, launchArgs: '--lang=en-GB' })
    expect(valueOf(args, '--profile')).toBe('/owner/browser-profile')
    expect(valueOf(args, '--args')).toBe('--lang=en-GB')
    expect(args).toContain('--headed')
    expect(args).not.toContain('--allowed-domains')
    expect(valueOf(args, '--idle-timeout')).toBe('300000')
  })

  it('attaches with --cdp alone: no list, window, profile, or arguments, and the same idle timeout, which only disconnects', async () => {
    const { args } = await run({ command: 'snapshot', args: [] }, { browser: { mode: ATTACHED }, approvedLists: approved, headed: true, launchArgs: '--lang=en-GB' })
    expect(valueOf(args, '--cdp')).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
    for (const flag of ['--allowed-domains', '--headed', '--profile', '--args']) expect(args).not.toContain(flag)
    expect(valueOf(args, '--idle-timeout')).toBe('300000')
    expect(valueOf(args, '--session')).toMatch(/^buckle-/)
  })

  it('attaches on close too, which agent-browser answers by disconnecting', async () => {
    const { args } = await run({ command: 'close', args: [] }, { browser: { mode: ATTACHED } })
    expect(args.slice(0, 2)).toEqual(['close', '--json'])
    expect(valueOf(args, '--cdp')).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
  })

  it('tells the agent in the tool description what close keeps in each mode', () => {
    const description = (mode: BrowserMode) => createBrowserPack({ cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: PROFILE, headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, approvedLists: [], browser: { mode }, runProcess: async () => stubResult() }).tools[0]!.capability.description
    expect(description({ kind: 'fresh' })).toBe('Run one agent-browser command against an isolated browser session; close discards browser state.')
    expect(description(PROFILE_MODE)).toContain('logins and cookies outlive close')
    expect(description(ATTACHED)).toContain('every session shares that browser and its logins, close only disconnects')
    // The approved list does not hold inside these browsers, and the description says what still is judged.
    for (const mode of [PROFILE_MODE, ATTACHED]) expect(description(mode)).toContain('Buckle judges only the page each command names')
    expect(description({ kind: 'fresh' })).not.toContain('judges only the page')
    expect(description(ATTACHED)).not.toContain('9222')
  })

  it('tells the agent in its skill that the list does not hold in a profile folder or an attached browser', () => {
    const skill = loadPackSkill('browser').content.replace(/\s+/g, ' ')
    expect(skill).toContain('That holds for a fresh browser only: agent-browser refuses the list with a profile folder or an attached browser, so there only the page a command names is judged')
  })

  it('relaunch notices come from a fresh browser alone, as only a fresh browser is passed the hosts', async () => {
    const notice = (output: unknown) => (output as { notice?: string }).notice
    const fresh = freshDirectory()
    await run({ command: 'snapshot', args: [] }, { sessionDirectory: fresh, approvedLists: approved })
    const changed = await run({ command: 'snapshot', args: [] }, { sessionDirectory: fresh, approvedLists: [{ name: 'workspace', entries: ['docs.test'] }] })
    expect(notice(changed.output)).toBe('The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.')
    for (const mode of [PROFILE_MODE, ATTACHED]) {
      const directory = freshDirectory()
      await run({ command: 'snapshot', args: [] }, { sessionDirectory: directory, browser: { mode }, approvedLists: approved })
      const again = await run({ command: 'snapshot', args: [] }, { sessionDirectory: directory, browser: { mode }, approvedLists: [{ name: 'workspace', entries: ['docs.test'] }] })
      expect(notice(again.output)).toBeUndefined()
      rmSync(directory, { recursive: true, force: true })
    }
    rmSync(fresh, { recursive: true, force: true })
  })

  it('withholds the pack, naming the setting, when the profile folder was refused', () => {
    const pack = createBrowserPack({ cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: PROFILE, headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, approvedLists: [], browser: { refusal: 'BUCKLE_BROWSER_PROFILE does not name an existing folder; create it first' }, runProcess: async () => stubResult() })
    expect(pack.unavailableReason).toBe('BUCKLE_BROWSER_PROFILE does not name an existing folder; create it first')
  })
})

// A stop that skipped the close step leaves a daemon running for its idle timeout, with the settings it was spawned
// with fixed in it; agent-browser reuses a running daemon by its session name.
describe('a session left by a run under other browser settings', () => {
  async function call(sessionDirectory: string, options: Partial<BrowserPackOptions>, calls: ProcessRequest[]) {
    const pack = createBrowserPack({ cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory, headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, approvedLists: [], runProcess: async (request) => { calls.push(request); return stubResult() }, ...options })
    await pack.tools[0]!.prepare({ command: 'snapshot', args: [] }).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1000, signal: new AbortController().signal })
  }
  const sessionOf = (request: ProcessRequest) => request.args[request.args.indexOf('--session') + 1]

  it.each<[string, Partial<BrowserPackOptions>]>([
    ['an attached browser', { browser: { mode: { kind: 'attached', endpoint: '9222' } } }],
    ['other arguments', { launchArgs: '--lang=en-GB' }],
    ['a window', { headed: true }],
  ])('is closed and replaced when the node now runs %s', async (_, changed) => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-browser-replaced-'))
    const calls: ProcessRequest[] = []
    await call(directory, {}, calls)
    await call(directory, {}, calls)
    expect(calls).toHaveLength(2)
    const first = sessionOf(calls[0]!)
    expect(sessionOf(calls[1]!)).toBe(first)
    await call(directory, changed, calls)
    expect(calls[2]!.args).toEqual(['close', '--session', first, '--json'])
    expect(sessionOf(calls[3]!)).toMatch(/^buckle-/)
    expect(sessionOf(calls[3]!)).not.toBe(first)
    expect(readFileSync(join(directory, 'sessions.json'), 'utf8')).not.toContain('9222')
    rmSync(directory, { recursive: true, force: true })
  })

  // The profile folder's one shared session is named from the folder, so a caller's old session is never it.
  it('is never the profile folder\'s shared session, and that session is replaced when its arguments change', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-browser-replaced-'))
    const calls: ProcessRequest[] = []
    const profile: Partial<BrowserPackOptions> = { browser: { mode: { kind: 'profile', directory: '/owner/profile' } } }
    await call(directory, {}, calls)
    await call(directory, profile, calls)
    const shared = sessionOf(calls[1]!)
    expect(shared).toMatch(/^buckle-profile-/)
    expect(shared).not.toBe(sessionOf(calls[0]!))
    await call(directory, { ...profile, launchArgs: '--lang=en-GB' }, calls)
    expect(calls[2]!.args).toEqual(['close', '--session', shared, '--json'])
    expect(sessionOf(calls[3]!)).toBe(shared)
    expect(readFileSync(join(directory, 'sessions.json'), 'utf8')).not.toContain('/owner/profile')
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('shutdown in an attached browser', () => {
  it('sends close to each session it opened, which agent-browser answers by disconnecting, and forgets it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-browser-shutdown-'))
    const calls: ProcessRequest[] = []
    const pack = createBrowserPack({ cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: directory, headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, approvedLists: [], browser: { mode: { kind: 'attached', endpoint: '9222' } }, runProcess: async (request) => { calls.push(request); return stubResult() } })
    await pack.tools[0]!.prepare({ command: 'open', args: ['example.com'] }).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1000, signal: new AbortController().signal })
    const session = calls[0]!.args[calls[0]!.args.indexOf('--session') + 1]!
    expect(calls[0]!.args).toContain('--cdp')
    await pack.close?.()
    expect(calls[1]!.args).toEqual(['close', '--session', session, '--json'])
    expect(JSON.parse(readFileSync(join(directory, 'sessions.json'), 'utf8'))).toEqual({ sessions: {}, allowedDomains: {}, modes: {} })
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('the warning a browser without in-browser containment logs at pack start', () => {
  // A fresh module each time, so each case sees the once-per-process warning anew.
  async function warnings(browser: BrowserPackOptions['browser']) {
    vi.resetModules()
    const log = await import('../common/runtime/log.js')
    const warn = vi.spyOn(log.logger, 'warn').mockImplementation(() => {})
    const { createBrowserPack: create } = await import('../common/services/packs/browser/index.js')
    const options = { cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: PROFILE, headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, approvedLists: [], runProcess: async () => stubResult(), ...(browser ? { browser } : {}) }
    create(options)
    create(options)
    const calls = warn.mock.calls
    warn.mockRestore()
    return calls
  }

  it('names the setting once, says containment is off and every login is reachable, and never prints the value', async () => {
    const attached = await warnings({ mode: { kind: 'attached', endpoint: 'ws://127.0.0.1:9222/devtools/browser/secret-id' } })
    expect(attached).toHaveLength(1)
    expect(attached[0]![0]).toContain('BUCKLE_BROWSER_CDP is set: the browser is not held to the approved list inside its pages, and every login in that browser is within the agent\'s reach')
    expect(attached[0]![1]).toEqual({ setting: 'BUCKLE_BROWSER_CDP' })
    expect(JSON.stringify(attached)).not.toContain('secret-id')
    const profile = await warnings({ mode: { kind: 'profile', directory: '/owner/private-profile' } })
    expect(profile).toHaveLength(1)
    expect(profile[0]![1]).toEqual({ setting: 'BUCKLE_BROWSER_PROFILE' })
    expect(JSON.stringify(profile)).not.toContain('private-profile')
  })

  it('stays quiet for a fresh browser', async () => {
    expect(await warnings(undefined)).toEqual([])
  })
})

describe('how the browser pack reports trouble', () => {
  it('surfaces an error written to stdout, which is where agent-browser puts it', async () => {
    await expect(run({ command: 'open', args: ['x'] }, {}, stubResult({ exitCode: 1, stdout: 'chrome is not installed' })))
      .rejects.toThrow('agent-browser failed (exit 1): chrome is not installed')
  })

  it('names the exit code even when the command said nothing at all', async () => {
    await expect(run({ command: 'snapshot', args: [] }, {}, stubResult({ exitCode: 2, stdout: '' })))
      .rejects.toThrow('agent-browser failed (exit 2) with no output')
  })

  it('reports why the pack is missing rather than pretending it is installed', () => {
    const pack = createBrowserPack({
      cwd: '/work',
      paths: createPathView({ root: '/work', mount: null }),
      agentBrowserCommand: '/opt/private/tools/agent-browser',
      sessionDirectory: PROFILE,
      headed: false,
      agentBrowser: { path: null, reason: '/opt/private/tools/agent-browser is not installed on this node', untrusted: false },
      approvedLists: [],
      runProcess: async () => stubResult(),
    })
    expect(pack.unavailableReason).toBe('agent-browser is not installed on this node, or BUCKLE_AGENT_BROWSER_COMMAND does not name it')
    expect(pack.unavailableReason).not.toContain('/opt/private')
  })
})

describe('what the browser pack declares it will touch', () => {
  function effectsFor(command: string, args: string[]) {
    return browserEffects(command, args)
  }

  it('declares navigation as a network effect, so the egress rule judges the URL', () => {
    expect(effectsFor('open', ['https://example.com']))
      .toEqual([{ kind: 'network', url: 'https://example.com/' }])
  })

  it('declares a file URL too, which is what puts it in front of the rule that refuses it', () => {
    expect(effectsFor('open', ['file:///etc/shadow']))
      .toEqual([{ kind: 'network', url: 'file:///etc/shadow' }])
  })

  it('judges a Windows drive letter as the scheme the egress rule refuses, rather than opening a local file unjudged', () => {
    expect(effectsFor('open', ['C:/Users/someone/page.html']))
      .toEqual([{ kind: 'network', url: 'c:/Users/someone/page.html' }])
  })

  it('does not mistake a Windows drive letter in a non-navigation argument for a URL', () => {
    expect(effectsFor('fill', ['@e1', 'C:/Users/someone/page.html'])).toEqual([])
  })

  it('declares a screenshot destination as a write, so it cannot land outside the sandbox', () => {
    expect(effectsFor('screenshot', ['out/page.png']))
      .toEqual([{ kind: 'write_path', path: 'out/page.png' }])
  })

  it('declares the screenshot path, not the value of a flag written before it', () => {
    expect(effectsFor('screenshot', ['--screenshot-quality', '80', '/elsewhere/page.png']))
      .toEqual([{ kind: 'write_path', path: '/elsewhere/page.png' }])
    expect(effectsFor('screenshot', ['--full', 'out/page.png']))
      .toEqual([{ kind: 'write_path', path: 'out/page.png' }])
  })

  it('declares nothing for a screenshot that only carries flags', () => {
    expect(effectsFor('screenshot', ['--full'])).toEqual([])
  })

  it('declares uploaded files as reads, since upload sends local files to a remote page', () => {
    expect(effectsFor('upload', ['@e3', 'a.pdf', 'b.pdf'])).toEqual([
      { kind: 'read_path', path: 'a.pdf' },
      { kind: 'read_path', path: 'b.pdf' },
    ])
  })

  it('declares a download destination as a write, skipping the selector', () => {
    expect(effectsFor('download', ['@e1', 'out/report.csv']))
      .toEqual([{ kind: 'write_path', path: 'out/report.csv' }])
  })
})

describe('flags the browser pack refuses outright', () => {
  it('refuses the flag that lets an open page read local files', () => {
    expect(refusedFlag(['--allow-file-access'])).toBe('--allow-file-access')
  })

  it('refuses the flag that would launch an arbitrary binary as the browser', () => {
    expect(refusedFlag(['--executable-path', '/bin/sh'])).toBe('--executable-path')
  })

  it('catches the equals form as well as the separated form', () => {
    expect(refusedFlag(['--executable-path=/bin/sh'])).toBe('--executable-path')
  })

  it('refuses a flag it simply does not know, naming it', () => {
    expect(refusedFlag(['--user-data-dir=/tmp/x'])).toBe('--user-data-dir')
  })

  it('refuses the flag that would hand the browser the owner\'s own profile', () => {
    expect(refusedFlag(['--profile', 'Default'])).toBe('--profile')
  })

  it('refuses a write flag that would land output where the path rules never look', () => {
    expect(refusedFlag(['--screenshot-dir', '/home/someone'])).toBe('--screenshot-dir')
  })

  it('leaves ordinary arguments alone', () => {
    expect(refusedFlag(['https://example.com', '--headed'])).toBeNull()
  })

  it('admits the flags agent-browser documents and Buckle can judge', () => {
    expect(refusedFlag(['-i'])).toBeNull()
    expect(refusedFlag(['--full', '--annotate'])).toBeNull()
    expect(refusedFlag(['--timeout=5s'])).toBeNull()
  })

  it('does not mistake a negative number for a flag', () => {
    expect(refusedFlag(['down', '-100'])).toBeNull()
  })

  it('refuses the call rather than running it', async () => {
    await expect(run({ command: 'open', args: ['https://x.com', '--allow-file-access'] }))
      .rejects.toThrow('--allow-file-access is not allowed')
  })
})

describe('a proxy chosen by the agent', () => {
  it.each([
    ['the equals form', ['example.com', '--proxy=http://10.0.0.5:3128']],
    ['the separate-argument form', ['example.com', '--proxy', '10.0.0.5:3128']],
    ['the flag written before the page', ['--proxy', '10.0.0.5:3128', 'example.com']],
    ['the flag after other arguments', ['example.com', '--headed', '--proxy', 'http://10.0.0.5:3128']],
    ['the bypass list in the equals form', ['example.com', '--proxy-bypass=*.internal']],
    ['the bypass list after other arguments', ['example.com', '--timeout', '5000', '--proxy-bypass', 'localhost']],
  ])('is refused before anything is judged, in %s', (_, args) => {
    expect(() => browserEffects('open', args)).toThrow(ToolInputError)
    expect(() => browserEffects('open', args)).toThrow(/Buckle owns the network policy/)
  })

  it('is refused on any command, not only open', () => {
    expect(() => browserEffects('snapshot', ['--proxy', '10.0.0.5:3128'])).toThrow(/--proxy is not allowed/)
    expect(() => browserEffects('tab', ['new', 'example.com', '--PROXY=http://10.0.0.5:3128'])).toThrow(/--proxy is not allowed/)
  })

  it('never reaches agent-browser', async () => {
    await expect(run({ command: 'open', args: ['example.com', '--proxy', '10.0.0.5:3128'] }))
      .rejects.toThrow('--proxy is not allowed: Buckle owns the network policy')
  })
})

describe('workspace browser isolation', () => {
  it('uses explicit configuration without a persistent profile', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args).not.toContain('--profile')
    expect(args[args.indexOf('--config') + 1]).toBe(join(PROFILE, 'fresh-config.json'))
  })
  it('keeps different workspace state keys separate', () => {
    expect(workspaceStateKey('/work/one')).not.toBe(workspaceStateKey('/work/two'))
  })
  it('names the same workspace the same way every start', () => {
    expect(workspaceStateKey('/work/one')).toBe(workspaceStateKey('/work/one/'))
  })
})

describe('the environment the browser is spawned with', () => {
  async function environmentFor(overrides: Record<string, string>) {
    const saved = { ...process.env }
    Object.assign(process.env, overrides)
    try {
      const calls: ProcessRequest[] = []
      const pack = createBrowserPack({
        cwd: '/work',
        paths: createPathView({ root: '/work', mount: null }),
        agentBrowserCommand: 'agent-browser',
        sessionDirectory: PROFILE,
        headed: false,
        agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' },
        approvedLists: [],
        runProcess: async request => {
          calls.push(request)
          return stubResult()
        },
      })
      const tool = pack.tools[0]
      if (!tool) throw new Error('the browser pack registered no tool')
      await tool.prepare({ command: 'snapshot', args: [] }).execute({
        requestId: 'r1',
        sessionId: 's1',
        timeoutMs: 1000,
        signal: new AbortController().signal,
      })
      return calls[0]?.environment ?? {}
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  }

  it('withholds ambient browser settings so fresh isolation cannot be overridden', async () => {
    const environment = await environmentFor({ AGENT_BROWSER_SCREENSHOT_DIR: 'C:/shots' })
    expect(environment.AGENT_BROWSER_SCREENSHOT_DIR).toBeUndefined()
  })

  it('still withholds Buckle\'s own token from the browser', async () => {
    const environment = await environmentFor({ BUCKLE_AUTH_TOKEN: 'super-secret' })
    expect(environment.BUCKLE_AUTH_TOKEN).toBeUndefined()
  })

  it('forwards nothing that merely mentions the tool without the prefix', async () => {
    const environment = await environmentFor({ MY_AGENT_BROWSER_HACK: 'no', AI_GATEWAY_API_KEY: 'sk-live' })
    expect(environment.MY_AGENT_BROWSER_HACK).toBeUndefined()
    expect(environment.AI_GATEWAY_API_KEY).toBeUndefined()
  })

  it('withholds the one setting that would replace the profile Buckle owns', async () => {
    const environment = await environmentFor({ AGENT_BROWSER_PROFILE: '/home/someone/.config/chrome' })
    expect(environment.AGENT_BROWSER_PROFILE).toBeUndefined()
  })

  it('keeps passing the variables a child genuinely needs', async () => {
    const environment = await environmentFor({})
    expect(environment.PATH).toBeDefined()
  })
})

describe('a page named without a scheme', () => {
  const judge = (args: string[], approved: string[] | null = ['allowed.test']) => {
    const engine = createPermissionEngine([createNetworkEgressRule({ approved: approved ? compileUrlPatterns(approved) : null })])
    const effects = browserEffects('open', args).map(effect => effect.kind === 'network' ? { kind: 'network' as const, url: new URL(effect.url) } : effect) as ResolvedEffect[]
    return engine.evaluate({ tool: 'browser_command', effects, grants: { subjectsFor: () => [] } })
  }

  it('is judged, and denied when the host is not on the approved list', () => {
    expect(judge(['example.com'])).toMatchObject({ kind: 'deny', denial: { rule: 'network_egress', subject: 'example.com' } })
    expect(judge(['allowed.test'])).toMatchObject({ kind: 'allow' })
  })

  it('is declared exactly like the same host written with https', () => {
    expect(browserEffects('open', ['example.com'])).toEqual(browserEffects('open', ['https://example.com']))
    expect(browserEffects('open', ['example.com/path?q=1'])).toEqual(browserEffects('open', ['https://example.com/path?q=1']))
  })

  it('reads localhost:3000 as host localhost on port 3000, not as a scheme', () => {
    const [effect] = browserEffects('open', ['localhost:3000'])
    expect(effect).toEqual({ kind: 'network', url: 'https://localhost:3000/' })
    expect(judge(['localhost:3000'], null)).toMatchObject({ kind: 'ask', asks: [{ rule: 'network_egress', subject: 'localhost:3000' }] })
  })

  it('judges the page of every command that loads one, skipping flag values', () => {
    expect(browserEffects('tab', ['new', 'example.com'])).toEqual([{ kind: 'network', url: 'https://example.com/' }])
    expect(browserEffects('goto', ['example.com'])).toEqual([{ kind: 'network', url: 'https://example.com/' }])
    expect(browserEffects('open', ['--headers', '{"x":"1"}', 'example.com'])).toEqual([{ kind: 'network', url: 'https://example.com/' }])
    expect(browserEffects('open', ['--headed', 'false', 'example.com'])).toEqual([{ kind: 'network', url: 'https://example.com/' }])
    expect(browserEffects('tab', ['2'])).toEqual([])
  })

  it.each([
    [['example.com', '--engine', 'chrome']],
    [['--headers', '{"x":"1"}', 'example.com']],
    [['--port', '9222', 'example.com']],
    [['--port=9222', 'example.com']],
    [['example.com', '--label=checkout', '--timeout', '5000']],
    [['--user-agent', 'Mozilla/5.0 (X11; Linux)', 'example.com']],
  ])('judges only the page, never a flag value: %j', args => {
    expect(browserEffects('open', args)).toEqual([{ kind: 'network', url: 'https://example.com/' }])
  })

  it('passes a flag value on as written rather than as a page', async () => {
    const { args } = await run({ command: 'open', args: ['example.com', '--engine', 'chrome', '--label', 'example.com'] })
    expect(args.slice(0, 6)).toEqual(['open', 'https://example.com/', '--engine', 'chrome', '--label', 'example.com'])
  })

  it('judges a host named true or false whenever it is the page, since boolean flags are known by name', () => {
    expect(browserEffects('open', ['true'])).toEqual([{ kind: 'network', url: 'https://true/' }])
    expect(browserEffects('open', ['--timeout', '5000', 'false'])).toEqual([{ kind: 'network', url: 'https://false/' }])
    expect(browserEffects('open', ['--engine', 'true', 'example.com'])).toEqual([{ kind: 'network', url: 'https://example.com/' }])
  })

  it('refuses open unless exactly one page is judged, so a word taken as a flag value cannot be the page', () => {
    expect(() => browserEffects('open', ['--headed', 'false'])).toThrow('open takes exactly one page to load, got 0')
    expect(() => browserEffects('open', ['example.com', 'true'])).toThrow('open takes exactly one page to load, got 2')
    expect(() => browserEffects('tab', ['new', 'a.example', 'b.example'])).toThrow('tab new takes at most one page to load, got 2')
    expect(browserEffects('tab', ['new'])).toEqual([])
  })

  it('hands agent-browser the judged page first, ahead of a boolean flag and its value', async () => {
    const { args } = await run({ command: 'open', args: ['--headed', 'false', 'example.com'] })
    expect(args.slice(0, 5)).toEqual(['open', 'https://example.com/', '--headed', 'false', '--json'])
    const tab = await run({ command: 'tab', args: ['--new-tab', 'true', 'new', 'example.com'] })
    expect(tab.args.slice(0, 5)).toEqual(['tab', 'new', 'https://example.com/', '--new-tab', 'true'])
  })

  it('refuses a target that is not a URL or a host, with the reason', () => {
    expect(() => browserEffects('open', ['/etc/passwd'])).toThrow(ToolInputError)
    expect(() => browserEffects('open', ['not a url'])).toThrow(/Not an http or https URL or a host/)
  })

  it('passes fill and type text containing a colon through unchanged, since text is not a page', async () => {
    expect(browserEffects('fill', ['@e1', 'Note: hello world'])).toEqual([])
    expect(browserEffects('type', ['@e1', 'Note: hi'])).toEqual([])
    expect(browserEffects('type', ['@e1', 'https://10.0.0.1/'])).toEqual([])
    const { args } = await run({ command: 'fill', args: ['@e1', 'Note: hello world'] })
    expect(args.slice(0, 3)).toEqual(['fill', '@e1', 'Note: hello world'])
  })

  it('still judges the page open names', () => {
    expect(judge(['https://example.com/'])).toMatchObject({ kind: 'deny', denial: { rule: 'network_egress', subject: 'example.com' } })
    expect(browserEffects('open', ['https://example.com/a:b'])).toEqual([{ kind: 'network', url: 'https://example.com/a:b' }])
  })

  it('hands agent-browser the URL that was judged', async () => {
    const { args } = await run({ command: 'open', args: ['localhost:3000'] })
    expect(args.slice(0, 2)).toEqual(['open', 'https://localhost:3000/'])
  })
})

// Review items 0 and 4 of the proof-of-possession fixes: agent-browser opens what it is handed with
// ordinary, link-following opens, so it only ever gets a private copy; Buckle reads and writes the
// workspace side itself, beneath a parent reached without following a link.
describe('file arguments reach agent-browser only through a private transfer', () => {
  function workspaceFixture() {
    const root = mkdtempSync(join(tmpdir(), 'buckle-browser-transfer-'))
    const workspace = join(root, 'workspace')
    const sessions = join(root, 'sessions')
    mkdirSync(join(workspace, 'shots'), { recursive: true })
    mkdirSync(join(root, 'outside'))
    return { root, workspace, sessions, paths: createPathView({ root: workspace, mount: null }) }
  }

  async function transfer(input: { command: string; args: string[]; workspace: string; sessions: string; context?: Partial<ToolContext>; process?: (request: ProcessRequest) => ProcessResult }) {
    const calls: ProcessRequest[] = []
    const pack = createBrowserPack({
      cwd: input.workspace, paths: createPathView({ root: input.workspace, mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: input.sessions,
      headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, approvedLists: [],
      runProcess: async (request) => { calls.push(request); return input.process?.(request) ?? stubResult() },
    })
    const execute = pack.tools[0]!.prepare({ command: input.command, args: input.args }).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1000, signal: new AbortController().signal, ...input.context })
    return { calls, execute }
  }

  it('hands a screenshot a private path, writes the image to its judged target, and names the agent\'s path', async () => {
    const { root, workspace, sessions } = workspaceFixture()
    const target = join(workspace, 'shots', 'page.png')
    const { calls, execute } = await transfer({ command: 'screenshot', args: ['shots/page.png'], workspace, sessions, context: { authorizeWrite: path => path === target }, process: (request) => {
      writeFileSync(request.args[1]!, 'png bytes')
      return stubResult({ stdout: JSON.stringify({ success: true, data: { path: request.args[1] } }) })
    } })
    const output = await execute
    expect(calls[0]!.args[1]).not.toBe(target)
    expect(calls[0]!.args[1]!.startsWith(`${sessions}/`)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('png bytes')
    expect(output).toMatchObject({ result: { data: { path: 'shots/page.png' } } })
    expect(readdirSync(sessions).filter(name => name.startsWith('transfer-'))).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('copies an upload into the transfer, under its own name, before agent-browser reads it', async () => {
    const { root, workspace, sessions } = workspaceFixture()
    writeFileSync(join(workspace, 'report.pdf'), 'pdf bytes')
    const seen: string[] = []
    const { calls, execute } = await transfer({ command: 'upload', args: ['#file', 'report.pdf'], workspace, sessions, context: { authorizeReadTarget: path => path === join(workspace, 'report.pdf') }, process: (request) => {
      seen.push(readFileSync(request.args[2]!, 'utf8'))
      return stubResult()
    } })
    await execute
    expect(calls[0]!.args[2]).toMatch(/\/transfer-[^/]+\/0\/report\.pdf$/)
    expect(seen).toEqual(['pdf bytes'])
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a screenshot whose directory a link replaced while the browser ran, and writes nothing outside', async () => {
    const { root, workspace, sessions } = workspaceFixture()
    const target = join(workspace, 'shots', 'page.png')
    const { execute } = await transfer({ command: 'screenshot', args: ['shots/page.png'], workspace, sessions, context: { authorizeWrite: path => path === target }, process: (request) => {
      writeFileSync(request.args[1]!, 'png bytes')
      rmSync(join(workspace, 'shots'), { recursive: true })
      symlinkSync(join(root, 'outside'), join(workspace, 'shots'))
      return stubResult()
    } })
    await expect(execute).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(readdirSync(join(root, 'outside'))).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses an upload whose file became a link after its check, before agent-browser runs', async () => {
    const { root, workspace, sessions } = workspaceFixture()
    writeFileSync(join(root, 'outside', 'secret.txt'), 'secret')
    symlinkSync(join(root, 'outside', 'secret.txt'), join(workspace, 'report.pdf'))
    const { calls, execute } = await transfer({ command: 'upload', args: ['#file', 'report.pdf'], workspace, sessions, context: { authorizeReadTarget: path => path === join(workspace, 'report.pdf') } })
    await expect(execute).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(calls).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})
