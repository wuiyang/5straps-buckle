import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, unreadWorkspaceDefaults, type NodeConfig } from '../common/runtime/config.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { runCli } from './support/cli.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// Phase 2 item 6 of the workspace-model brief (Q10, D84 (2)): the browser's idle timeout and the owner's modes (an
// attached Chrome, a profile folder, arguments, a window) are each workspace's; a profile folder or an attached Chrome
// belongs to one workspace at a time, and a second is refused, naming the one that holds it.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-browser-workspaces-')))
  roots.push(root)
  return root
}

/** Two workspaces, alpha registered before beta, on a node with a fake agent-browser that records its arguments. */
async function node(environment: Record<string, string> = {}) {
  const root = scratch()
  for (const folder of ['alpha', 'beta', 'profile', 'other-profile']) mkdirSync(join(root, folder))
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdout.write('{"success":true}')\n`)
  chmodSync(binary, 0o755)
  const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'browser-workspaces-admin-credential', BUCKLE_PACKS: 'browser', BUCKLE_AGENT_BROWSER_COMMAND: binary, ...environment })
  const manager = await workspacesOf(config)
  for (const name of ['alpha', 'beta']) await registerWorkspace(manager, { id: name, dir: join(root, name) })
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  return { root, config, manager, calls }
}

function open(manager: WorkspaceManager, name: string, call: { command: string; args: string[] } = { command: 'snapshot', args: [] }) {
  return byName(manager, name).then(({ runtime }) => runtime.invoke({ request: { requestId: `open-${randomUUID()}`, tool: 'browser_command', args: call, approvalTokens: [] }, sessionId: name }))
}

const HELD = (holder: string, what = 'The profile folder this browser keeps its logins in') => `${what} belongs to workspace ${holder}, and serves one workspace at a time; the owner chooses which with buckle workspace set browser.profile or browser.cdp`

async function set(config: NodeConfig, name: string, key: string, value: string) {
  let err = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const { exitCode } = await runCli({ argv: ['workspace', 'set', key, value, '--workspace', name], config, confirm: null, cwd: '/' })
  vi.restoreAllMocks()
  return { exitCode, err }
}

describe('a workspace\'s browser settings', () => {
  it('are its own: its window and idle timeout reach its browser alone', async () => {
    const { config, manager, calls } = await node()
    expect((await set(config, 'alpha', 'browser.headed', 'on')).exitCode).toBe(0)
    expect((await set(config, 'alpha', 'browser.idleTimeoutMs', '120000')).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    const [alpha, beta] = calls()
    expect(alpha).toContain('--headed')
    expect(alpha![alpha!.indexOf('--idle-timeout') + 1]).toBe('120000')
    expect(beta).not.toContain('--headed')
    expect(beta![beta!.indexOf('--idle-timeout') + 1]).toBe('300000')
    await manager.close()
  })

  it('come from the node\'s environment file alone, whatever the caller\'s env says', () => {
    const layers = { file: { path: '/state/buckle.env', values: {} }, caller: { BUCKLE_BROWSER_PROFILE: '/owner/profile', BUCKLE_BROWSER_HEADED: 'true' } }
    expect(loadConfig({ ...layers.caller }, process.platform, layers).workspaceDefaults.browser).toEqual({})
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_BROWSER_PROFILE', 'BUCKLE_BROWSER_HEADED'])
  })
})

describe('a profile folder', () => {
  it('belongs to the workspace that names it as its own: another naming it too is refused, naming the holder', async () => {
    const { root, config, manager, calls } = await node()
    expect((await set(config, 'alpha', 'browser.profile', join(root, 'profile'))).exitCode).toBe(0)
    const refused = await set(config, 'beta', 'browser.profile', join(root, 'profile'))
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('That profile folder belongs to workspace alpha, and serves one workspace at a time: unset it there first')
    expect(refused.err).not.toContain(join(root, 'profile'))
    expect((await set(config, 'beta', 'browser.profile', join(root, 'other-profile'))).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    expect(calls().map(call => call[call.indexOf('--profile') + 1])).toEqual([join(root, 'profile'), join(root, 'other-profile')])
    await manager.close()
  })

  it('the node names belongs to the first online workspace taking it, and to one naming it as its own over that', async () => {
    const root = scratch()
    mkdirSync(join(root, 'shared-profile'))
    const { config, manager, calls } = await node({ BUCKLE_BROWSER_PROFILE: join(root, 'shared-profile') })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'error', error: { message: 'The profile folder this browser keeps its logins in belongs to workspace alpha, and serves one workspace at a time; the owner chooses which with buckle workspace set browser.profile or browser.cdp' } })
    // beta names the node's folder as its own: it holds it from now on, and alpha is the one refused, at its next call.
    expect((await set(config, 'beta', 'browser.profile', join(root, 'shared-profile'))).exitCode).toBe(0)
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('belongs to workspace beta') } })
    // Taken offline, beta holds nothing, and alpha has the folder again.
    await manager.update(idOf(manager, 'beta'), { online: false })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(calls().filter(call => call[0] === 'snapshot')).toHaveLength(3)
    await manager.close()
  })
})

// The one-owner rule keys the Chrome or folder the pack really reaches, not the setting's spelling.
describe('another spelling of a profile folder', { timeout: 20_000 }, () => {
  it('through a link, set with the command line, is refused naming the holder', async () => {
    const { root, config, manager } = await node()
    symlinkSync(join(root, 'profile'), join(root, 'profile-link'))
    expect((await set(config, 'alpha', 'browser.profile', join(root, 'profile'))).exitCode).toBe(0)
    const refused = await set(config, 'beta', 'browser.profile', join(root, 'profile-link'))
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('That profile folder belongs to workspace alpha')
    expect(refused.err).not.toContain(root)
    await manager.close()
  })

  it('by a hand edit with a trailing slash, or the node\'s through a link, is refused at the call, naming the holder', async () => {
    const root = scratch()
    mkdirSync(join(root, 'real-profile'))
    symlinkSync(join(root, 'real-profile'), join(root, 'profile-link'))
    const { config, manager, calls } = await node({ BUCKLE_BROWSER_PROFILE: join(root, 'profile-link') })
    expect((await set(config, 'alpha', 'browser.profile', join(root, 'real-profile'))).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    // beta takes the node's folder, the same one through a link.
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('belongs to workspace alpha') } })
    const file = settingsPath(config.stateDirectory, idOf(manager, 'beta'))
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { browser?: Record<string, unknown> }
    writeFileSync(file, JSON.stringify({ ...stored, browser: { ...stored.browser, profile: `${join(root, 'real-profile')}/` } }))
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('belongs to workspace alpha') } })
    expect(calls().filter(call => call[0] === 'snapshot')).toHaveLength(1)
    await manager.close()
  })
})

describe('an attached Chrome', () => {
  it.each(['http://127.0.0.1:9222', 'http://localhost:9222/', 'ws://127.0.0.1:9222/devtools/browser/x', 'HTTP://127.0.0.1:9222', 'http://[::1]:9222', 'ws://user:secret@localhost:9222/devtools/browser/y?token=t'])('named %s is the one at port 9222 another workspace holds, and is refused naming only the holder', { timeout: 20_000 }, async (spelling) => {
    const { config, manager } = await node()
    expect((await set(config, 'alpha', 'browser.cdp', '9222')).exitCode).toBe(0)
    const refused = await set(config, 'beta', 'browser.cdp', spelling)
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('That Chrome belongs to workspace alpha')
    for (const part of ['9222', 'secret', 'token']) expect(refused.err).not.toContain(part)
    await manager.close()
  })

  it('is told apart by host and port alone', async () => {
    const { cdpEndpointKey } = await import('../common/services/packs/browser/mode.js')
    expect(cdpEndpointKey('9222')).toBe('127.0.0.1:9222')
    expect(cdpEndpointKey('https://Chrome.Example.test/devtools')).toBe('chrome.example.test:9222')
    expect(cdpEndpointKey('wss://chrome.example.test')).toBe('chrome.example.test:443')
    expect(cdpEndpointKey('ws://chrome.example.test/')).toBe('chrome.example.test:80')
    expect(cdpEndpointKey('http://127.0.0.1:9333')).not.toBe(cdpEndpointKey('9222'))
  })

  it('belongs to one workspace at a time, as a profile folder does', async () => {
    const { config, manager } = await node()
    expect((await set(config, 'alpha', 'browser.cdp', '9222')).exitCode).toBe(0)
    const refused = await set(config, 'beta', 'browser.cdp', '9222')
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('That Chrome belongs to workspace alpha')
    expect(refused.err).not.toContain('9222')
    expect((await set(config, 'beta', 'browser.cdp', '9333')).exitCode).toBe(0)
    await manager.close()
  })
})

// The per-call rule for the owner's Chrome, as for a profile folder: the node's setting alone reaches two workspaces,
// and neither names it as its own, so the set-time refusal never fires.
describe('an attached Chrome two workspaces reach', { timeout: 20_000 }, () => {
  it('is used by the first online workspace taking the node\'s, and the second is refused naming it, never the endpoint', async () => {
    const { manager, calls } = await node({ BUCKLE_BROWSER_CDP: '9222' })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    const refused = await open(manager, 'beta')
    expect(refused).toMatchObject({ outcome: 'error', error: { message: HELD('alpha', 'The owner\'s Chrome this browser attaches to') } })
    expect(JSON.stringify(refused)).not.toContain('9222')
    expect(calls()).toHaveLength(1)
    await manager.close()
  })

  it('belongs to the one naming it as its own, over the node\'s, and to the other again once that one is offline', async () => {
    const { config, manager, calls } = await node({ BUCKLE_BROWSER_CDP: '9222' })
    expect((await set(config, 'beta', 'browser.cdp', '9222')).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('The owner\'s Chrome this browser attaches to belongs to workspace beta') } })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    await manager.update(idOf(manager, 'beta'), { online: false })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(calls().filter(call => call[0] === 'snapshot')).toHaveLength(2)
    await manager.close()
  })
})

// A workspace whose packs leave the browser out uses no profile folder or Chrome, so it holds none.
describe('the holder of the node\'s browser', { timeout: 20_000 }, () => {
  it.each([
    ['profile', (root: string) => ({ BUCKLE_BROWSER_PROFILE: join(root, 'shared-profile') })],
    ['attached', () => ({ BUCKLE_BROWSER_CDP: '9222' })],
  ])('is not a workspace whose own packs leave the %s browser out: the next one takes it', async (_, setting) => {
    const root = scratch()
    mkdirSync(join(root, 'shared-profile'))
    const { config, manager, calls } = await node(setting(root))
    expect((await set(config, 'alpha', 'packs.enabled', 'fs')).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error', error: { code: 'TOOL_NOT_FOUND' } })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    expect(calls()).toHaveLength(1)
    await manager.close()
  })

  it('is read from the packs in force, the node\'s included: a workspace turning the browser on over a node that leaves it out holds it', async () => {
    const root = scratch()
    mkdirSync(join(root, 'shared-profile'))
    const { config, manager } = await node({ BUCKLE_PACKS: 'fs', BUCKLE_BROWSER_PROFILE: join(root, 'shared-profile') })
    expect((await set(config, 'beta', 'packs.enabled', 'fs,browser')).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error', error: { code: 'TOOL_NOT_FOUND' } })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    await manager.close()
  })
})

// The browser's mode is one unit: a workspace naming an attached Chrome or a profile folder of its own takes both from
// itself, and the block in force with the node's defaults meets the checks the node's own settings meet, at each write
// and wherever the browser is chosen, so a hand edit passes nothing `buckle workspace set` refuses.
describe('the browser block in force', { timeout: 20_000 }, () => {
  async function handWritten(config: NodeConfig, manager: WorkspaceManager, name: string, browser: Record<string, unknown>) {
    const file = settingsPath(config.stateDirectory, idOf(manager, name))
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...stored, browser }))
  }
  const withheld = async (manager: WorkspaceManager, name: string) => (await byName(manager, name)).runtime.manifest().packs.find(pack => pack.id === 'browser')?.unavailableReason

  it('takes a workspace\'s own profile folder over the node\'s attached Chrome, which it then leaves alone', async () => {
    const { root, config, manager, calls } = await node({ BUCKLE_BROWSER_CDP: '9222' })
    expect((await set(config, 'alpha', 'browser.profile', join(root, 'profile'))).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    const [alpha, beta] = calls()
    expect(alpha![alpha!.indexOf('--profile') + 1]).toBe(join(root, 'profile'))
    expect(alpha).not.toContain('--cdp')
    expect(beta![beta!.indexOf('--cdp') + 1]).toBe('9222')
    await manager.close()
  })

  it('takes a workspace\'s own attached Chrome over the node\'s profile and window, which it does not apply', async () => {
    const root = scratch()
    mkdirSync(join(root, 'node-profile'))
    const { config, manager, calls } = await node({ BUCKLE_BROWSER_PROFILE: join(root, 'node-profile'), BUCKLE_BROWSER_HEADED: 'true', BUCKLE_BROWSER_ARGS: '--lang=en-GB' })
    expect((await set(config, 'alpha', 'browser.cdp', '9333')).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    const [alpha] = calls()
    expect(alpha!.slice(alpha!.indexOf('--idle-timeout'))).toEqual(['--idle-timeout', '300000', '--cdp', '9333'])
    await manager.close()
  })

  it.each([['browser.headed', 'on'], ['browser.args', '--disable-gpu']])('refuses %s of a workspace\'s own beside the node\'s attached Chrome, naming BUCKLE_BROWSER_CDP', async (key, value) => {
    const { config, manager } = await node({ BUCKLE_BROWSER_CDP: '9222' })
    const refused = await set(config, 'alpha', key, value)
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain(`BUCKLE_BROWSER_CDP cannot be set with ${key}: an attached browser keeps the profile, arguments, and window its owner started it with`)
    expect(refused.err).not.toContain('9222')
    await manager.close()
  })

  it.each([
    ['a profile switch in the arguments', { args: '--user-data-dir=/elsewhere/profile' }, 'browser.args may not pass --user-data-dir'],
    ['a relative path climbing out of the state folder', { args: '--load-extension=../../../../alpha/ext' }, 'browser.args names a path by a spelling Buckle cannot place'],
    ['a page switch', { args: '--restore-last-session' }, 'browser.args'],
    ['an attached Chrome beside a profile', { cdp: '9222', profile: '/elsewhere/profile' }, 'browser.cdp cannot be set with browser.profile'],
  ])('withholds the browser for %s written into workspace.json by hand, as the command line refuses it', async (_, browser, reason) => {
    const { config, manager, calls } = await node()
    await handWritten(config, manager, 'alpha', browser)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error' })
    expect(await withheld(manager, 'alpha')).toContain(reason)
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    expect(calls()).toHaveLength(1)
    await manager.close()
  })

  it('withholds the browser for a window written by hand beside the node\'s attached Chrome, naming each by its layer', async () => {
    const { config, manager, calls } = await node({ BUCKLE_BROWSER_CDP: '9222' })
    await handWritten(config, manager, 'alpha', { headed: true })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error' })
    expect(await withheld(manager, 'alpha')).toBe('BUCKLE_BROWSER_CDP cannot be set with browser.headed: an attached browser keeps the profile, arguments, and window its owner started it with')
    expect(calls()).toEqual([])
    await manager.close()
  })
})
