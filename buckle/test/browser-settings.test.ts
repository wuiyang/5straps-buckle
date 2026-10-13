import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootsOf } from '../common/domain/executable.js'
import { actionsPath, loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { chooseBrowser } from '../common/services/packs/browser/mode.js'
import { createSetupViews } from '../common/services/setup/setup-views.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

// A node owner may point the browser pack at a browser that keeps a login, and pass extra Chromium arguments. Fresh
// sessions stay the default, and nothing an agent sends selects these modes.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function base(): { root: string; workspace: string; state: string; environment: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'buckle-browser-settings-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const state = join(root, 'state')
  return { root, workspace, state, environment: { BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_PACKS: 'browser', BUCKLE_ALLOW_SHELL: 'false' } }
}

describe('reading the browser settings', () => {
  it('reads a DevTools port, and a ws://, wss://, http://, or https:// URL, as written', () => {
    const { environment } = base()
    for (const value of ['9222', 'ws://127.0.0.1:9222/devtools/browser/abc', 'wss://browser.example/?token=t', 'http://127.0.0.1:9222', 'https://browser.example:9443']) {
      expect(loadConfig({ ...environment, BUCKLE_BROWSER_CDP: value }).browserCdp).toBe(value)
    }
  })

  // agent-browser reads the scheme in lower case only, and quotes the whole value when it cannot.
  it.each([
    ['WS://127.0.0.1:9222/devtools/browser/Abc', 'ws://127.0.0.1:9222/devtools/browser/Abc'],
    ['Wss://browser.example/?token=Kept', 'wss://browser.example/?token=Kept'],
    ['HTTP://127.0.0.1:9222', 'http://127.0.0.1:9222'],
    ['HTTPS://browser.example:9443', 'https://browser.example:9443'],
  ])('lowers the scheme of %s and keeps the rest as written', (value, passed) => {
    const { environment } = base()
    expect(loadConfig({ ...environment, BUCKLE_BROWSER_CDP: value }).browserCdp).toBe(passed)
  })

  it.each(['chrome', '0', '70000', 'ftp://browser.example/?token=never-shown', 'file:///tmp/devtools'])('refuses %s as BUCKLE_BROWSER_CDP without echoing it', value => {
    const { environment } = base()
    expect(() => loadConfig({ ...environment, BUCKLE_BROWSER_CDP: value })).toThrow('Invalid BUCKLE_BROWSER_CDP: expected a DevTools port such as 9222, or a ws://, wss://, http://, or https:// URL')
    expect(() => loadConfig({ ...environment, BUCKLE_BROWSER_CDP: value })).not.toThrow(value)
  })

  it('reads an empty line, as .env.example ships them, as unset: a fresh browser', () => {
    const { environment } = base()
    const config = loadConfig({ ...environment, BUCKLE_BROWSER_CDP: '', BUCKLE_BROWSER_PROFILE: '', BUCKLE_BROWSER_ARGS: ' ' })
    expect([config.browserCdp, config.browserProfile, config.browserArgs]).toEqual([undefined, undefined, undefined])
  })

  it('refuses a relative profile folder, naming the setting and never the path', () => {
    const { environment } = base()
    const load = () => loadConfig({ ...environment, BUCKLE_BROWSER_PROFILE: 'profiles/private-name' })
    expect(load).toThrow('BUCKLE_BROWSER_PROFILE must be an absolute path')
    expect(load).not.toThrow('private-name')
  })

  it('keeps the owner\'s arguments as one string, which agent-browser splits at commas and new lines', () => {
    const { environment } = base()
    expect(loadConfig({ ...environment, BUCKLE_BROWSER_ARGS: '--disable-blink-features=AutomationControlled,--lang=en-GB' }).browserArgs).toBe('--disable-blink-features=AutomationControlled,--lang=en-GB')
  })

  it.each(['--user-data-dir=/elsewhere', '--lang=en-GB,-User-Data-Dir /elsewhere', '--lang=en-GB\n--profile-directory=Default', '/user-data-dir=/elsewhere'])('refuses arguments that choose a profile folder: %j', value => {
    const { environment } = base()
    expect(() => loadConfig({ ...environment, BUCKLE_BROWSER_ARGS: value })).toThrow(/BUCKLE_BROWSER_ARGS may not pass --(?:user-data-dir|profile-directory): name a profile folder with BUCKLE_BROWSER_PROFILE/)
  })

  it.each([
    [{ BUCKLE_BROWSER_PROFILE: '/owner/profile' }, 'BUCKLE_BROWSER_PROFILE'],
    [{ BUCKLE_BROWSER_ARGS: '--lang=en-GB' }, 'BUCKLE_BROWSER_ARGS'],
    [{ BUCKLE_BROWSER_HEADED: 'true' }, 'BUCKLE_BROWSER_HEADED'],
    [{ BUCKLE_BROWSER_PROFILE: '/owner/profile', BUCKLE_BROWSER_HEADED: 'true' }, 'BUCKLE_BROWSER_PROFILE or BUCKLE_BROWSER_HEADED'],
  ])('refuses to start with BUCKLE_BROWSER_CDP beside %j, naming the settings', (settings, named) => {
    const { environment } = base()
    const load = () => loadConfig({ ...environment, BUCKLE_BROWSER_CDP: 'ws://127.0.0.1:9222/?token=never-shown', ...settings })
    expect(load).toThrow(`BUCKLE_BROWSER_CDP cannot be set with ${named}: an attached browser keeps the profile, arguments, and window its owner started it with`)
    expect(load).not.toThrow('never-shown')
  })

  it('lets BUCKLE_BROWSER_HEADED=false stand beside an attached browser, as the shipped example writes it', () => {
    const { environment } = base()
    expect(loadConfig({ ...environment, BUCKLE_BROWSER_CDP: '9222', BUCKLE_BROWSER_HEADED: 'false' }).browserCdp).toBe('9222')
  })
})

describe('where a profile folder may lie', () => {
  function folders() {
    const { root, workspace, state } = base()
    const scratch = join(root, 'scratch')
    const outside = join(root, 'outside')
    mkdirSync(scratch)
    mkdirSync(join(outside, 'profile'), { recursive: true })
    const untrusted = { untrustedRoots: [...rootsOf('workspace', [workspace]), ...rootsOf('scratch root', [scratch])], rootsUnknown: null }
    const choose = (profile: string) => chooseBrowser({ profile, untrusted, protectedRoots: [state] })
    return { root, workspace, state, scratch, outside, choose }
  }
  const UNTRUSTED = 'BUCKLE_BROWSER_PROFILE names a folder inside or around a workspace, a scratch root, or the node\'s state directory, where an agent can write or Buckle keeps its state, so Buckle does not load it'

  it('loads an existing folder outside every root, handed on as the folder it really is', () => {
    const { outside, root, choose } = folders()
    expect(choose(join(outside, 'profile'))).toEqual({ mode: { kind: 'profile', directory: join(outside, 'profile') } })
    symlinkSync(join(outside, 'profile'), join(root, 'linked-profile'))
    expect(choose(join(root, 'linked-profile'))).toEqual({ mode: { kind: 'profile', directory: join(outside, 'profile') } })
  })

  it('refuses a folder inside the workspace, a scratch root, or the state directory, naming the setting and never the path', () => {
    const { workspace, scratch, state, choose } = folders()
    for (const folder of [join(workspace, 'profile'), join(scratch, 'profile'), join(state, 'profile')]) {
      mkdirSync(folder, { recursive: true })
      expect(choose(folder)).toEqual({ refusal: UNTRUSTED })
    }
  })

  it('refuses a folder reached through a link inside the workspace, which the agent could point elsewhere', () => {
    const { workspace, outside, root, choose } = folders()
    symlinkSync(join(outside, 'profile'), join(workspace, 'profile-link'))
    expect(choose(join(workspace, 'profile-link'))).toEqual({ refusal: UNTRUSTED })
    symlinkSync(join(workspace), join(root, 'into-workspace'))
    mkdirSync(join(workspace, 'profile'))
    expect(choose(join(root, 'into-workspace', 'profile'))).toEqual({ refusal: UNTRUSTED })
  })

  it('refuses a folder that holds a workspace, as Chrome reads every folder beneath its profile', () => {
    const { root, choose } = folders()
    expect(choose(root)).toEqual({ refusal: UNTRUSTED })
  })

  it('refuses a folder that does not exist yet', () => {
    const { outside, choose } = folders()
    expect(choose(join(outside, 'not-made'))).toEqual({ refusal: 'BUCKLE_BROWSER_PROFILE does not name an existing folder; create it first' })
    writeFileSync(join(outside, 'a-file'), '')
    expect(choose(join(outside, 'a-file'))).toEqual({ refusal: 'BUCKLE_BROWSER_PROFILE does not name an existing folder; create it first' })
  })

  it('refuses every folder while the workspace registry cannot be read', () => {
    const { outside, state } = folders()
    expect(chooseBrowser({ profile: join(outside, 'profile'), untrusted: { untrustedRoots: [], rootsUnknown: 'the workspace registry cannot be read' }, protectedRoots: [state] }))
      .toEqual({ refusal: 'BUCKLE_BROWSER_PROFILE is not loaded while the workspace registry cannot be read' })
  })

  it('withholds the browser pack of a real runtime, naming the setting', async () => {
    const { environment, workspace } = base()
    mkdirSync(join(workspace, 'profile'))
    const runtime = await createRuntime({ config: loadConfig({ ...environment, BUCKLE_AGENT_BROWSER_COMMAND: process.execPath, BUCKLE_BROWSER_PROFILE: join(workspace, 'profile') }) })
    const pack = runtime.manifest().packs.find(item => item.id === 'browser')
    expect(pack?.unavailableReason).toBe(UNTRUSTED)
    expect(runtime.registry().has('browser_command')).toBe(false)
  })
})

/** A fake agent-browser that records its arguments and answers as `answer` writes, success by default. */
async function runtimeFixture(settings: NodeJS.ProcessEnv, options: { answer?: string; args?: JsonObject } = {}) {
  const { root, environment } = base()
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  writeFileSync(binary, `#!/usr/bin/env node\nconst argv = process.argv.slice(2)\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')\n${options.answer ?? 'process.stdout.write(\'{"success":true}\')'}\n`)
  chmodSync(binary, 0o755)
  const config = loadConfig({ ...environment, BUCKLE_AGENT_BROWSER_COMMAND: binary, BUCKLE_NETWORK_ALLOW: 'example.com', ...settings })
  const runtime = await createRuntime({ config })
  const response = await runtime.invoke({ request: { requestId: `browse-${randomUUID()}`, tool: 'browser_command', args: options.args ?? { command: 'snapshot', args: [] }, approvalTokens: [] }, sessionId: 'browsing-agent' })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  const status = await createSetupViews().status({ config, runtime })
  return { root, config, runtime, response, calls, call: calls[0] ?? [], status, description: runtime.registry().capabilities().find(tool => tool.name === 'browser_command')?.description }
}

describe('what a real runtime hands a fake agent-browser in each mode', () => {
  const fixture = (settings: NodeJS.ProcessEnv) => runtimeFixture(settings)
  const valueOf = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

  it('holds a fresh browser to the approved list, with the owner\'s arguments, and reports it fresh', async () => {
    const { response, call, status } = await fixture({ BUCKLE_BROWSER_ARGS: '--disable-blink-features=AutomationControlled' })
    expect(response.outcome).toBe('ok')
    expect(valueOf(call, '--allowed-domains')).toBe('example.com')
    expect(valueOf(call, '--args')).toBe('--disable-blink-features=AutomationControlled')
    expect(status.browser).toEqual({ mode: 'fresh', setting: null })
  })

  it('launches the profile folder without the list, and reports the mode by its setting alone', async () => {
    const { root } = base()
    const profile = join(root, 'owner-profile')
    mkdirSync(profile)
    const { response, call, status, description } = await fixture({ BUCKLE_BROWSER_PROFILE: profile, BUCKLE_BROWSER_HEADED: 'true' })
    expect(response.outcome).toBe('ok')
    expect(valueOf(call, '--profile')).toBe(profile)
    expect(call).toContain('--headed')
    expect(call).not.toContain('--allowed-domains')
    expect(status.browser).toEqual({ mode: 'profile', setting: 'BUCKLE_BROWSER_PROFILE' })
    expect(JSON.stringify(status)).not.toContain('owner-profile')
    expect(description).toContain('logins and cookies outlive close')
  })

  it('attaches with --cdp alone, and reports the mode without the endpoint', async () => {
    const { response, call, status, description } = await fixture({ BUCKLE_BROWSER_CDP: 'ws://127.0.0.1:9222/devtools/browser/never-shown' })
    expect(response.outcome).toBe('ok')
    expect(valueOf(call, '--cdp')).toBe('ws://127.0.0.1:9222/devtools/browser/never-shown')
    for (const flag of ['--allowed-domains', '--headed', '--profile', '--args']) expect(call).not.toContain(flag)
    expect(valueOf(call, '--idle-timeout')).toBe('300000')
    expect(status.browser).toEqual({ mode: 'attached', setting: 'BUCKLE_BROWSER_CDP' })
    expect(JSON.stringify(status)).not.toContain('never-shown')
    expect(description).toContain('close only disconnects')
  })
})

// agent-browser names the endpoint it could not reach, and folds Chrome's launch errors, which name the profile
// folder, into its own; neither value may reach the agent or the action log.
describe('a failing agent-browser in an owner-chosen mode', () => {
  // Prints the endpoint as written and by its host and port, or the profile folder in a Chrome lock error, and fails.
  const FAILING = [
    `const after = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null`,
    `const cdp = after('--cdp'), profile = after('--profile')`,
    `if (profile) process.stderr.write('[ERROR:process_singleton] Failed to create ' + profile + '/SingletonLock: File exists\\n')`,
    `const host = cdp && (/^\\d+$/.test(cdp) ? '127.0.0.1:' + cdp : new URL(cdp).host)`,
    `if (cdp) process.stdout.write(JSON.stringify({ success: false, error: 'All CDP discovery methods failed for ' + host + ': ' + cdp }))`,
    `process.exit(1)`,
  ].join('\n')

  async function failing(settings: NodeJS.ProcessEnv) {
    const warn = vi.spyOn(logger, 'warn')
    const fixture = await runtimeFixture(settings, { answer: FAILING })
    const logged = JSON.stringify(warn.mock.calls)
    warn.mockRestore()
    if (fixture.response.outcome !== 'error') throw new Error(`expected an error, got ${fixture.response.outcome}`)
    const audit = readFileSync(actionsPath(fixture.config), 'utf8')
    return { ...fixture, message: fixture.response.error.message, audit, logged }
  }

  it.each([
    ['a bare port', '9222', ['127.0.0.1:9222', '9222']],
    ['an http:// URL', 'http://cdp-host.test:9333', ['cdp-host.test:9333']],
    ['a ws:// URL with a password and a browser id', 'ws://owner:secret@127.0.0.1:9222/devtools/browser/never-shown', ['secret', 'never-shown', '127.0.0.1:9222']],
  ])('shows BUCKLE_BROWSER_CDP in place of %s', async (_, endpoint, hidden) => {
    const { message, audit, logged, status, description, call } = await failing({ BUCKLE_BROWSER_CDP: endpoint })
    expect(call[call.indexOf('--cdp') + 1]).toBe(endpoint)
    expect(message).toContain('All CDP discovery methods failed for BUCKLE_BROWSER_CDP')
    for (const text of [message, audit, logged, JSON.stringify(status), description ?? '']) {
      for (const value of hidden) expect(text).not.toContain(value)
    }
  })

  it('shows BUCKLE_BROWSER_PROFILE in place of the folder Chrome names in its launch error', async () => {
    const { root } = base()
    const profile = join(root, 'owner-profile-never-shown')
    mkdirSync(profile)
    const { message, audit } = await failing({ BUCKLE_BROWSER_PROFILE: profile })
    expect(message).toContain('Failed to create BUCKLE_BROWSER_PROFILE/SingletonLock')
    expect(message).not.toContain('never-shown')
    expect(audit).not.toContain('never-shown')
  })
})
