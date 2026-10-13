import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPack } from '../common/services/packs/browser/index.js'
import type { BrowserMode } from '../common/services/packs/browser/mode.js'
import { createPathView } from '../common/domain/path-view.js'
import { loadConfig } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(mode: BrowserMode = { kind: 'fresh' }) {
  const root = mkdtempSync('/tmp/buckle-fresh-browser-'); roots.push(root)
  const calls: ProcessRequest[] = []
  const pack = createBrowserPack({ cwd: root, paths: createPathView({ root, mount: null }), sessionDirectory: join(root, 'state'), agentBrowserCommand: 'agent-browser', agentBrowser: { path: 'agent-browser', argv0: 'agent-browser' }, headed: false, approvedLists: [], browser: { mode }, runProcess: async request => { calls.push(request); return { exitCode: 0, signal: null, stdout: '{}', stderr: '', truncated: false, timedOut: false } } })
  const context = { requestId: 'request', sessionId: 'owner-agent', timeoutMs: 1000, signal: new AbortController().signal }
  return { root, calls, tool: pack.tools[0]!, context }
}
function browserSession(call: ProcessRequest): string { return call.args[call.args.indexOf('--session') + 1]! }

it('keeps a fresh browser through a task, isolates callers, and rotates it on close', async () => {
  const { calls, tool, context } = fixture()
  await tool.prepare({ command: 'open', args: ['https://example.com'] }).execute(context)
  await tool.prepare({ command: 'snapshot' }).execute(context)
  expect(browserSession(calls[0]!)).toBe(browserSession(calls[1]!))
  expect(calls[0]!.args).not.toContain('--profile')
  await tool.prepare({ command: 'snapshot' }).execute({ ...context, sessionId: 'other-agent' })
  expect(browserSession(calls[2]!)).not.toBe(browserSession(calls[0]!))
  await tool.prepare({ command: 'close' }).execute(context)
  await tool.prepare({ command: 'open', args: ['https://example.com'] }).execute(context)
  expect(browserSession(calls[4]!)).not.toBe(browserSession(calls[0]!))
})

it('ignores ambient attach, profile and restore settings', async () => {
  vi.stubEnv('AGENT_BROWSER_CDP', '9222'); vi.stubEnv('AGENT_BROWSER_PROFILE', 'Default'); vi.stubEnv('AGENT_BROWSER_RESTORE', 'owner')
  const { calls, tool, context, root } = fixture()
  await tool.prepare({ command: 'snapshot' }).execute(context)
  expect(calls[0]!.environment?.AGENT_BROWSER_CDP).toBeUndefined()
  expect(calls[0]!.environment?.AGENT_BROWSER_PROFILE).toBeUndefined()
  expect(calls[0]!.environment?.AGENT_BROWSER_RESTORE).toBeUndefined()
  expect(calls[0]!.cwd).toBe(join(root, 'state'))
  expect(calls[0]!.args).toContain('--config')
})

const MODES: Array<[string, BrowserMode]> = [
  ['a fresh browser', { kind: 'fresh' }],
  ['a profile folder', { kind: 'profile', directory: '/owner/profile' }],
  ['an attached browser', { kind: 'attached', endpoint: '9222' }],
]

describe.each(MODES)('on %s', (_, mode) => {
  it.each(['connect', 'state', 'auth', 'cookies', 'profiles', 'batch'])('refuses the %s command by name', async command => {
    const { calls, tool, context } = fixture(mode)
    await expect(tool.prepare({ command }).execute(context)).rejects.toThrow(`${command} is not run: Buckle's browser cannot attach, restore, or override session identity`)
    expect(calls).toHaveLength(0)
  })

  // The owner's settings alone choose the browser: the flags that would choose another stay refused by name.
  it.each(['--cdp', '--auto-connect', '--profile', '--args'])('refuses %s by name before anything is judged', flag => {
    const { calls, tool } = fixture(mode)
    expect(() => tool.prepare({ command: 'snapshot', args: [flag, 'value'] })).toThrow(`${flag} is not allowed`)
    expect(() => tool.prepare({ command: 'snapshot', args: [`${flag}=value`] })).toThrow(`${flag} is not allowed`)
    expect(calls).toHaveLength(0)
  })

  it.each(['--state', '--restore', '--session'])('refuses %s by name, in either spelling', async flag => {
    const { calls, tool, context } = fixture(mode)
    await expect(tool.prepare({ command: 'snapshot', args: [flag, 'saved'] }).execute(context)).rejects.toThrow(`${flag} is not allowed: Buckle's browser cannot attach`)
    await expect(tool.prepare({ command: 'snapshot', args: [`${flag.toUpperCase()}=saved`] }).execute(context)).rejects.toThrow(`${flag} is not allowed`)
    expect(calls).toHaveLength(0)
  })
})

it('exposes only browser tools when the owner selects the browser pack', async () => {
  const { root } = fixture(); const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_AGENT_BROWSER_COMMAND: process.execPath })
  const runtime = await createRuntime({ config })
  expect(runtime.registry().capabilities().map(tool => tool.name)).toEqual(['browser_command'])
  expect(runtime.registry().has('fs_read')).toBe(false)
  expect(runtime.registry().has('shell_exec')).toBe(false)
})

it('rejects a global flag smuggled into the command field', () => {
  const { tool } = fixture()
  expect(() => tool.prepare({ command: '--profile', args: ['Default'] })).toThrow()
})

it('starts separate browsers for different message stages in the same caller session', async () => {
  const { calls, tool, context } = fixture()
  await tool.prepare({ command: 'snapshot' }).execute({ ...context, stageId: 'first-message' })
  await tool.prepare({ command: 'snapshot' }).execute({ ...context, stageId: 'second-message' })
  expect(browserSession(calls[0]!)).not.toBe(browserSession(calls[1]!))
})
