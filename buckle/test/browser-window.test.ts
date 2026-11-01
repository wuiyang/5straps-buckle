import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { logger } from '../common/runtime/log.js'
import { createBrowserPack, type BrowserPackOptions } from '../common/services/packs/browser/index.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'

// Slice F4, item 1 (browser lifecycle, owner's Windows report of 2026-11-02): one browser_command call opened two
// visible windows, Chrome's own startup window beside the page agent-browser made (agent-browser #1544), and each
// call of a node with no console opened a console window of its own.

const DIRECTORY = mkdtempSync(join(tmpdir(), 'buckle-browser-window-'))
afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }))

const OK: ProcessResult = { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false }

function pack(options: Partial<BrowserPackOptions> = {}, answer: (request: ProcessRequest) => ProcessResult = () => OK) {
  const calls: ProcessRequest[] = []
  const built = createBrowserPack({
    cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: mkdtempSync(join(DIRECTORY, 'state-')),
    headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser', args: [] }, approvedLists: [],
    runProcess: async (request) => { calls.push(request); return answer(request) },
    ...options,
  })
  const call = (input: Record<string, unknown>) => built.tools[0]!.prepare(input as never).execute({ requestId: 'r', sessionId: 's', timeoutMs: 1000, signal: new AbortController().signal })
  return { pack: built, calls, call }
}

const valueOf = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
const commandCall = (calls: ProcessRequest[], command: string) => calls.find(request => request.args[0] === command)!

describe('the launch arguments of a browser Buckle starts', () => {
  it('passes --no-startup-window to a fresh browser, after the owner\'s own arguments', async () => {
    const { calls, call } = await pack({ launchArgs: '--disable-blink-features=AutomationControlled' })
    await call({ command: 'snapshot' })
    expect(valueOf(commandCall(calls, 'snapshot').args, '--args')).toBe('--disable-blink-features=AutomationControlled,--no-startup-window')
  })

  it('passes --no-startup-window alone where the owner set no arguments', async () => {
    const { calls, call } = await pack()
    await call({ command: 'open', args: ['https://example.com'] })
    expect(valueOf(commandCall(calls, 'open').args, '--args')).toBe('--no-startup-window')
  })

  it('passes it to a profile folder\'s browser too, after the owner\'s arguments', async () => {
    const { calls, call } = await pack({ browser: { mode: { kind: 'profile', directory: '/owner/profile' } }, launchArgs: '--lang=en-GB' })
    await call({ command: 'snapshot' })
    expect(valueOf(commandCall(calls, 'snapshot').args, '--args')).toBe('--lang=en-GB,--no-startup-window')
  })

  it.each(['--no-startup-window', '--No-Startup-Window', '--lang=en-GB,--no-startup-window', '--no-startup-window=false'])('passes %s as the owner wrote it, never the switch twice', async (owner) => {
    const { calls, call } = await pack({ launchArgs: owner })
    await call({ command: 'snapshot' })
    expect(valueOf(commandCall(calls, 'snapshot').args, '--args')).toBe(owner)
  })

  it('passes no --args to an attached Chrome, which keeps the windows its owner opened', async () => {
    const { calls, call } = await pack({ browser: { mode: { kind: 'attached', endpoint: '9222' } }, launchArgs: '--lang=en-GB' })
    await call({ command: 'snapshot' })
    expect(commandCall(calls, 'snapshot').args).not.toContain('--args')
  })
})

describe('the agent-browser processes Buckle starts', () => {
  it('starts each with no console window of its own, the command and its closes alike', async () => {
    const { pack: built, calls, call } = await pack()
    await call({ command: 'open', args: ['https://example.com'] })
    await built.close?.()
    expect(calls.map(request => request.args[0])).toEqual(['open', 'close'])
    expect(calls.every(request => request.windowsHide === true)).toBe(true)
  })
})

describe('an agent-browser older than 0.37.1 on Windows', () => {
  const version = (text: string) => (request: ProcessRequest): ProcessResult => request.args.includes('--version') ? { ...OK, stdout: `${text}\n` } : OK
  const warnings = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][]).filter(([message]) => String(message).startsWith('agent-browser '))

  it('is named once in the owner\'s log at pack start, with the version to upgrade to', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const program = { path: '/opt/old/agent-browser.exe', argv0: 'agent-browser', args: [] }
      const first = await pack({ platform: 'win32', agentBrowser: program }, version('agent-browser 0.36.2'))
      await vi.waitFor(() => expect(warnings(warn)).toHaveLength(1))
      expect(first.calls.filter(request => request.args.includes('--version'))).toEqual([expect.objectContaining({ command: program.path, windowsHide: true })])
      expect(warnings(warn)[0]![0]).toBe('agent-browser 0.36.2 is older than 0.37.1, which on Windows shows a headless browser\'s windows on the desktop and can leave a browser open when its daemon ends; upgrade it with npm i -g agent-browser@latest')
      const second = await pack({ platform: 'win32', agentBrowser: program }, version('agent-browser 0.36.2'))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(second.calls).toEqual([])
      expect(warnings(warn)).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['agent-browser 0.37.1', 'agent-browser 0.41.1', 'agent-browser 1.0.0'])('is quiet for %s', async (text) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const { calls } = await pack({ platform: 'win32', agentBrowser: { path: `/opt/${text.replaceAll(' ', '-')}.exe`, argv0: 'agent-browser', args: [] } }, version(text))
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(warnings(warn)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('is never asked for elsewhere, nor where the pack is withheld', async () => {
    const elsewhere = await pack({ platform: 'linux', agentBrowser: { path: '/opt/linux/agent-browser', argv0: 'agent-browser', args: [] } })
    const withheld = await pack({ platform: 'win32', browser: { refusal: 'BUCKLE_BROWSER_PROFILE does not name an existing folder; create it first' }, agentBrowser: { path: '/opt/withheld/agent-browser.exe', argv0: 'agent-browser', args: [] } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect([...elsewhere.calls, ...withheld.calls]).toEqual([])
  })
})
