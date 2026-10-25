import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserArgumentsRefusal } from '../common/domain/browser-arguments.js'
import { rootsOf } from '../common/domain/executable.js'
import { actionsPath } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { logger } from '../common/runtime/log.js'
import { chooseBrowser, settingScrubber } from '../common/services/packs/browser/mode.js'
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
      expect(configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: value }).browserCdp).toBe(value)
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
    expect(configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: value }).browserCdp).toBe(passed)
  })

  it.each(['chrome', '0', '70000', 'ftp://browser.example/?token=never-shown', 'file:///tmp/devtools'])('refuses %s as BUCKLE_BROWSER_CDP without echoing it', value => {
    const { environment } = base()
    expect(() => configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: value })).toThrow('Invalid BUCKLE_BROWSER_CDP: expected a DevTools port such as 9222, or a ws://, wss://, http://, or https:// URL')
    expect(() => configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: value })).not.toThrow(value)
  })

  it('reads an empty line, as .env.example ships them, as unset: a fresh browser', () => {
    const { environment } = base()
    const config = configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: '', BUCKLE_BROWSER_PROFILE: '', BUCKLE_BROWSER_ARGS: ' ' })
    expect([config.browserCdp, config.browserProfile, config.browserArgs]).toEqual([undefined, undefined, undefined])
  })

  it('refuses a relative profile folder, naming the setting and never the path', () => {
    const { environment } = base()
    const load = () => configFromEnvironment({ ...environment, BUCKLE_BROWSER_PROFILE: 'profiles/private-name' })
    expect(load).toThrow('BUCKLE_BROWSER_PROFILE must be an absolute path')
    expect(load).not.toThrow('private-name')
  })

  it('keeps the owner\'s arguments as one string, which agent-browser splits at commas and new lines', () => {
    const { environment } = base()
    expect(configFromEnvironment({ ...environment, BUCKLE_BROWSER_ARGS: '--disable-blink-features=AutomationControlled,--lang=en-GB' }).browserArgs).toBe('--disable-blink-features=AutomationControlled,--lang=en-GB')
  })

  it.each(['--user-data-dir=/elsewhere', '--lang=en-GB,-User-Data-Dir /elsewhere', '--lang=en-GB\n--profile-directory=Default'])('refuses arguments that choose a profile folder: %j', value => {
    const { environment } = base()
    expect(() => configFromEnvironment({ ...environment, BUCKLE_BROWSER_ARGS: value })).toThrow(/BUCKLE_BROWSER_ARGS may not pass --(?:user-data-dir|profile-directory): name a profile folder with BUCKLE_BROWSER_PROFILE/)
  })

  // agent-browser refuses these beside an approved list, at every launch, so they are refused at start.
  it.each([
    ['--restore-last-session', 'restore-last-session'],
    ['--lang=en-GB,--Restore-Session', 'restore-session'],
    ['--app=https://never-shown.example', 'app'],
    ['-app-id=never-shown', 'app-id'],
    ['--app-launch-url-for-shortcuts-menu-item=https://never-shown.example', 'app-launch-url-for-shortcuts-menu-item'],
    ['--load-and-launch-app=/never-shown', 'load-and-launch-app'],
  ])('refuses %j, which restores or opens pages, naming the switch alone', (value, name) => {
    const { environment } = base()
    const load = () => configFromEnvironment({ ...environment, BUCKLE_BROWSER_ARGS: value })
    expect(load).toThrow(`BUCKLE_BROWSER_ARGS may not pass --${name}: it restores or opens pages before the approved list holds, so agent-browser refuses it beside one`)
    expect(load).not.toThrow('never-shown')
  })

  // Read as on Linux whatever host runs the test, where a leading slash is never a switch.
  it.each(['https://never-shown.example', '--lang=en-GB,never-shown.example', '/never-shown/folder', '/never-shown', '/lang=en-GB', 'file:///never-shown', '--window-size=1280,720'])('refuses %j, which is not a switch off Windows, without echoing it', value => {
    const refusal = browserArgumentsRefusal(value, 'linux')
    expect(refusal).toContain('BUCKLE_BROWSER_ARGS holds an argument that is not a switch, such as a page, a path, or the part of one switch after a comma')
    expect(refusal).not.toContain('never-shown')
  })

  const UNPLACED = 'BUCKLE_BROWSER_ARGS names a path by a spelling Buckle cannot place: a .. segment, a leading ./ or ~, a file: URL, or on Windows a drive or a root alone; give its absolute path, which Buckle judges where it lies'

  // A .. climbs out of Buckle's browser state directory, where Chrome resolves a relative value, and ~ is the home folder.
  it.each(['./never-shown', '../never-shown', 'a/../never-shown', 'never-shown/..', '~/never-shown', '~', '.\\never-shown', 'a\\..\\never-shown', 'file:///never-shown', 'FILE://host/never-shown'])('refuses --load-extension=%s with its own fixed text', value => {
    expect(browserArgumentsRefusal(`--lang=en-GB,--load-extension=${value}`, 'linux')).toBe(UNPLACED)
  })

  it('refuses a relative path at start through the node\'s configuration', () => {
    const { environment } = base()
    const load = () => configFromEnvironment({ ...environment, BUCKLE_BROWSER_ARGS: '--disk-cache-dir=../never-shown' })
    expect(load).toThrow(UNPLACED)
    expect(load).not.toThrow('never-shown')
  })

  // A bare relative name resolves against Buckle's browser state directory, where no agent writes.
  it.each(['--accept-lang=text/plain', '--proxy-server=socks5://host:1080', '--host-rules=10.0.0.0/8', '--cookie-domain=.example.com', '--scale=.5', '--load-extension=ext', '--disk-cache-dir=cache/sub'])('passes %s, which names no path Buckle cannot place, on Linux and on Windows', value => {
    expect(browserArgumentsRefusal(value, 'linux')).toBeNull()
    expect(browserArgumentsRefusal(value, 'win32')).toBeNull()
    expect(chooseBrowser({ args: value, untrusted: { untrustedRoots: [], rootsUnknown: null }, protectedRoots: [], platform: 'win32' })).toEqual({ mode: { kind: 'fresh' } })
  })

  it('refuses on Windows, through the configuration, a profile folder rooted at a slash alone', () => {
    const load = () => configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: 'C:/work', BUCKLE_STATE_DIR: 'C:/state', BUCKLE_BROWSER_PROFILE: '/owner/never-shown' }, 'win32')
    expect(load).toThrow('BUCKLE_BROWSER_PROFILE must be an absolute path')
    expect(load).not.toThrow('never-shown')
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: 'C:/work', BUCKLE_STATE_DIR: 'C:/state', BUCKLE_BROWSER_PROFILE: 'C:/owner/profile' }, 'win32').browserProfile).toBe('C:/owner/profile')
  })

  it('passes a URL value and an absolute path, which the pack judges where it lies', () => {
    const value = '--lang=en-GB,--proxy-pac-url=https://pac.example/proxy.pac,--load-extension=/opt/extensions/reader'
    expect(browserArgumentsRefusal(value, 'linux')).toBeNull()
    const { environment } = base()
    expect(configFromEnvironment({ ...environment, BUCKLE_BROWSER_ARGS: '--lang=en-GB' }).browserArgs).toBe('--lang=en-GB')
  })

  it('reads a slash prefix as a switch on Windows alone, and refuses a drive-relative path there', () => {
    expect(browserArgumentsRefusal('/lang=en-GB', 'win32')).toBeNull()
    expect(browserArgumentsRefusal('/user-data-dir=C:/elsewhere', 'win32')).toContain('BUCKLE_BROWSER_ARGS may not pass --user-data-dir')
    expect(browserArgumentsRefusal('/load-and-launch-app=C:/x', 'win32')).toContain('BUCKLE_BROWSER_ARGS may not pass --load-and-launch-app')
    expect(browserArgumentsRefusal('--load-extension=C:ext', 'win32')).toBe(UNPLACED)
    expect(browserArgumentsRefusal('--load-extension=\\ext', 'win32')).toBe(UNPLACED)
    expect(browserArgumentsRefusal('--load-extension=/ext', 'win32')).toBe(UNPLACED)
    expect(browserArgumentsRefusal('--load-extension=C:/extensions/reader', 'win32')).toBeNull()
    expect(browserArgumentsRefusal('--load-extension=\\\\server\\share\\reader', 'win32')).toBeNull()
    expect(browserArgumentsRefusal('--load-extension=/opt/reader', 'linux')).toBeNull()
    for (const platform of ['linux', 'darwin'] as const) expect(browserArgumentsRefusal('/etc', platform)).toContain('holds an argument that is not a switch')
  })

  it.each([
    [{ BUCKLE_BROWSER_PROFILE: '/owner/profile' }, 'BUCKLE_BROWSER_PROFILE'],
    [{ BUCKLE_BROWSER_ARGS: '--lang=en-GB' }, 'BUCKLE_BROWSER_ARGS'],
    [{ BUCKLE_BROWSER_HEADED: 'true' }, 'BUCKLE_BROWSER_HEADED'],
    [{ BUCKLE_BROWSER_PROFILE: '/owner/profile', BUCKLE_BROWSER_HEADED: 'true' }, 'BUCKLE_BROWSER_PROFILE or BUCKLE_BROWSER_HEADED'],
  ])('refuses to start with BUCKLE_BROWSER_CDP beside %j, naming the settings', (settings, named) => {
    const { environment } = base()
    const load = () => configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: 'ws://127.0.0.1:9222/?token=never-shown', ...settings })
    expect(load).toThrow(`BUCKLE_BROWSER_CDP cannot be set with ${named}: an attached browser keeps the profile, arguments, and window its owner started it with`)
    expect(load).not.toThrow('never-shown')
  })

  it('lets BUCKLE_BROWSER_HEADED=false stand beside an attached browser, as the shipped example writes it', () => {
    const { environment } = base()
    expect(configFromEnvironment({ ...environment, BUCKLE_BROWSER_CDP: '9222', BUCKLE_BROWSER_HEADED: 'false' }).browserCdp).toBe('9222')
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

  // Judged first by the checks the node's own settings meet at start, as a hand-edited workspace.json is (browserBlockRefusal).
  it('refuses on Windows a folder rooted at a slash alone, which names whichever drive is current', () => {
    const untrusted = { untrustedRoots: [], rootsUnknown: null }
    for (const folder of ['/owner/profile', '\\owner\\profile']) {
      expect(chooseBrowser({ profile: folder, untrusted, protectedRoots: [], platform: 'win32' })).toEqual({ refusal: 'BUCKLE_BROWSER_PROFILE must be an absolute path: Buckle never resolves a browser profile against the working directory' })
    }
    expect(chooseBrowser({ args: '--load-extension=/owner/ext', untrusted, protectedRoots: [], platform: 'win32' }))
      .toEqual({ refusal: expect.stringMatching(/^BUCKLE_BROWSER_ARGS names a path by a spelling Buckle cannot place: .* on Windows a drive or a root alone/) })
  })

  it('refuses a folder that is itself the workspace, a scratch root, or the state directory', () => {
    const { workspace, scratch, state, choose } = folders()
    mkdirSync(state, { recursive: true })
    for (const folder of [workspace, scratch, state]) expect(choose(folder)).toEqual({ refusal: UNTRUSTED })
  })

  it('refuses a case variant of a root where the disk ignores case, and the source of a writable mount', () => {
    const { workspace, outside, state } = folders()
    const darwin = chooseBrowser({ profile: join(workspace.toUpperCase(), 'profile'), untrusted: { untrustedRoots: rootsOf('workspace', [workspace]), rootsUnknown: null }, protectedRoots: [state], platform: 'darwin' })
    expect(darwin).toEqual({ refusal: UNTRUSTED })
    const mounted = chooseBrowser({ profile: join(outside, 'profile'), untrusted: { untrustedRoots: rootsOf('writable mount', [outside]), rootsUnknown: null }, protectedRoots: [state] })
    expect(mounted).toEqual({ refusal: UNTRUSTED })
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

  it.each(['load-extension', 'disk-cache-dir'])('refuses an argument whose --%s names a folder inside or around a root, or through a link there', (name) => {
    const { root, workspace, scratch, state, outside, choose } = folders()
    const untrusted = { untrustedRoots: [...rootsOf('workspace', [workspace]), ...rootsOf('scratch root', [scratch])], rootsUnknown: null }
    const withArgs = (args: string) => chooseBrowser({ args, untrusted, protectedRoots: [state] })
    const refused = { refusal: 'BUCKLE_BROWSER_ARGS names a path inside or around a workspace, a scratch root, or the node\'s state directory, where an agent can write or Buckle keeps its state, so Buckle does not pass it' }
    symlinkSync(join(workspace), join(root, 'into-workspace'))
    for (const folder of [join(workspace, 'ext'), join(scratch, 'ext'), join(state, 'ext'), workspace, root, join(root, 'into-workspace', 'ext')]) {
      expect(withArgs(`--lang=en-GB,--${name}=${folder}`)).toEqual(refused)
    }
    expect(withArgs(`--${name}=${join(outside, 'ext')}`)).toEqual({ mode: { kind: 'fresh' } })
    expect(chooseBrowser({ args: `--${name}=${join(workspace, 'ext')}`, profile: join(outside, 'profile'), untrusted, protectedRoots: [state] })).toEqual(refused)
    expect(choose(join(outside, 'profile'))).toEqual({ mode: { kind: 'profile', directory: join(outside, 'profile') } })
  })

  // The system reads these as absolute although pathe reads them otherwise, so each is judged, never passed unjudged.
  it('judges a path spelled //./ on Linux, and refuses a device path on Windows', () => {
    const { workspace, outside, state } = folders()
    const untrusted = { untrustedRoots: rootsOf('workspace', [workspace]), rootsUnknown: null }
    const refused = { refusal: 'BUCKLE_BROWSER_ARGS names a path inside or around a workspace, a scratch root, or the node\'s state directory, where an agent can write or Buckle keeps its state, so Buckle does not pass it' }
    expect(chooseBrowser({ args: `--load-extension=//.${workspace}/ext`, untrusted, protectedRoots: [state], platform: 'linux' })).toEqual(refused)
    expect(chooseBrowser({ args: `--load-extension=//.${outside}/ext`, untrusted, protectedRoots: [state], platform: 'linux' })).toEqual({ mode: { kind: 'fresh' } })
    for (const device of ['\\\\.\\C:\\ws\\ext', '\\\\?\\C:\\ws\\ext']) {
      expect(chooseBrowser({ args: `--load-extension=${device}`, untrusted: { untrustedRoots: rootsOf('workspace', ['C:/ws']), rootsUnknown: null }, protectedRoots: [], platform: 'win32' })).toEqual(refused)
    }
  })

  it('passes arguments that name no path whatever the roots, and refuses a path while the registry cannot be read', () => {
    const { outside } = folders()
    const unknown = { untrustedRoots: [], rootsUnknown: 'the workspace registry cannot be read' }
    expect(chooseBrowser({ args: '--lang=en-GB,--disable-blink-features=AutomationControlled', untrusted: unknown, protectedRoots: [] })).toEqual({ mode: { kind: 'fresh' } })
    expect(chooseBrowser({ args: `--load-extension=${join(outside, 'ext')}`, untrusted: unknown, protectedRoots: [] }))
      .toEqual({ refusal: 'BUCKLE_BROWSER_ARGS is not passed while the workspace registry cannot be read' })
  })

  it.each(['the workspace', 'the state directory', 'a scratch root'])('withholds the browser pack of a real runtime for a folder inside %s, naming the setting', async (place) => {
    const { root, environment, workspace, state } = base()
    const scratch = join(root, 'scratch')
    mkdirSync(scratch)
    mkdirSync(state, { recursive: true })
    const folder = join({ 'the workspace': workspace, 'the state directory': state, 'a scratch root': scratch }[place]!, 'profile')
    mkdirSync(folder)
    const config = configFromEnvironment({ ...environment, BUCKLE_SCRATCH_ROOTS: scratch, BUCKLE_AGENT_BROWSER_COMMAND: process.execPath, BUCKLE_BROWSER_PROFILE: folder })
    const runtime = await createRuntime({ config })
    const pack = runtime.manifest().packs.find(item => item.id === 'browser')
    expect(pack?.unavailableReason).toBe(UNTRUSTED)
    expect(runtime.registry().has('browser_command')).toBe(false)
    // The status says the mode the settings chose and that it is withheld, naming the setting, never the folder.
    const status = await createSetupViews().status({ config, runtime })
    expect(status.browser).toEqual({ mode: 'profile', setting: 'BUCKLE_BROWSER_PROFILE', withheld: UNTRUSTED })
    expect(JSON.stringify(status.browser)).not.toContain(folder)
  })

  it('reports the browser pack withheld when BUCKLE_PACKS leaves it out, or when agent-browser is missing', async () => {
    const { environment } = base()
    const left = configFromEnvironment({ ...environment, BUCKLE_PACKS: 'fs' })
    expect((await createSetupViews().status({ config: left, runtime: await createRuntime({ config: left }) })).browser)
      .toEqual({ mode: 'fresh', setting: null, withheld: 'the workspace setting packs.enabled leaves the browser pack out' })
    const missing = configFromEnvironment({ ...environment, BUCKLE_AGENT_BROWSER_COMMAND: join(environment.BUCKLE_WORKSPACE_ROOT!, '..', 'no-such-agent-browser') })
    expect((await createSetupViews().status({ config: missing, runtime: await createRuntime({ config: missing }) })).browser)
      .toEqual({ mode: 'fresh', setting: null, withheld: 'BUCKLE_AGENT_BROWSER_COMMAND names a path that holds no program Buckle can run' })
  })
})

/** A fake agent-browser that records its arguments and answers as `answer` writes, success by default. */
async function runtimeFixture(settings: NodeJS.ProcessEnv, options: { answer?: string; args?: JsonObject } = {}) {
  const { root, environment } = base()
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  writeFileSync(binary, `#!/usr/bin/env node\nconst argv = process.argv.slice(2)\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')\n${options.answer ?? 'process.stdout.write(\'{"success":true}\')'}\n`)
  chmodSync(binary, 0o755)
  const config = configFromEnvironment({ ...environment, BUCKLE_AGENT_BROWSER_COMMAND: binary, BUCKLE_NETWORK_ALLOW: 'example.com', ...settings })
  const runtime = await createRuntime({ config })
  const response = await runtime.invoke({ request: { requestId: `browse-${randomUUID()}`, tool: 'browser_command', args: options.args ?? { command: 'snapshot', args: [] }, approvalTokens: [] }, sessionId: 'browsing-agent' })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  const status = await createSetupViews().status({ config, runtime })
  return { root, config, runtime, response, calls, call: calls[0] ?? [], status, description: runtime.registry().capabilities().find(tool => tool.name === 'browser_command')?.description }
}

describe('what a real runtime hands a fake agent-browser in each mode', () => {
  const fixture = (settings: NodeJS.ProcessEnv) => runtimeFixture(settings)

  // The approved list does not hold inside these browsers, but the page a command names is judged as ever.
  it.each(['profile', 'attached'])('judges the page a command opens in %s mode, and runs nothing for a page the list leaves out', async (mode) => {
    const { root } = base()
    const profile = join(root, 'judged-profile')
    mkdirSync(profile)
    const settings = mode === 'profile' ? { BUCKLE_BROWSER_PROFILE: profile } : { BUCKLE_BROWSER_CDP: '9222' }
    const denied = await runtimeFixture(settings, { args: { command: 'open', args: ['https://other.test/'] } })
    expect(denied.response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(denied.calls).toEqual([])
    const allowed = await runtimeFixture(settings, { args: { command: 'open', args: ['example.com'] } })
    expect(allowed.response.outcome).toBe('ok')
    expect(allowed.call.slice(0, 2)).toEqual(['open', 'https://example.com/'])
  })
  const valueOf = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

  it('holds a fresh browser to the approved list, with the owner\'s arguments, and reports it fresh', async () => {
    const { response, call, status } = await fixture({ BUCKLE_BROWSER_ARGS: '--disable-blink-features=AutomationControlled' })
    expect(response.outcome).toBe('ok')
    expect(valueOf(call, '--allowed-domains')).toBe('example.com')
    expect(valueOf(call, '--args')).toBe('--disable-blink-features=AutomationControlled')
    expect(status.browser).toEqual({ mode: 'fresh', setting: null, withheld: null })
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
    expect(status.browser).toEqual({ mode: 'profile', setting: 'BUCKLE_BROWSER_PROFILE', withheld: null })
    expect(JSON.stringify(status)).not.toContain('owner-profile')
    expect(description).toContain('logins and cookies outlive close')
  })

  it('attaches with --cdp alone, and reports the mode without the endpoint', async () => {
    const { response, call, status, description } = await fixture({ BUCKLE_BROWSER_CDP: 'ws://127.0.0.1:9222/devtools/browser/never-shown' })
    expect(response.outcome).toBe('ok')
    expect(valueOf(call, '--cdp')).toBe('ws://127.0.0.1:9222/devtools/browser/never-shown')
    for (const flag of ['--allowed-domains', '--headed', '--profile', '--args']) expect(call).not.toContain(flag)
    expect(valueOf(call, '--idle-timeout')).toBe('300000')
    expect(status.browser).toEqual({ mode: 'attached', setting: 'BUCKLE_BROWSER_CDP', withheld: null })
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
    ['a ws:// URL with a password and a browser id', 'ws://owner:decoy-password@127.0.0.1:9222/devtools/browser/never-shown', ['decoy-password', 'never-shown', '127.0.0.1:9222']],
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

describe('the forms of a setting the scrub replaces', () => {
  const attached = (endpoint: string) => settingScrubber({ kind: 'attached', endpoint }, 'linux')

  it('leaves the digits of a bare port in a successful result, and replaces them in failure text alone', () => {
    const scrub = attached('9222')
    const page = JSON.stringify({ success: true, data: { snapshot: 'Order 9222 ships with 19222 and 92220 units' } })
    expect(scrub(page, false)).toBe(page)
    expect(scrub('All CDP discovery methods failed for 127.0.0.1:9222: Cannot connect to Chrome on port 9222; 9222 refused, 19222 not', true))
      .toBe('All CDP discovery methods failed for BUCKLE_BROWSER_CDP: Cannot connect to Chrome on port BUCKLE_BROWSER_CDP; BUCKLE_BROWSER_CDP refused, 19222 not')
    expect(scrub('connected to localhost:9222', false)).toBe('connected to BUCKLE_BROWSER_CDP')
  })

  it('replaces the URL as URL writes it, with a trailing slash', () => {
    expect(attached('http://cdp-host.test')('could not reach http://cdp-host.test/', true)).toBe('could not reach BUCKLE_BROWSER_CDP')
  })

  it('replaces the host on the port agent-browser probes for an http value with a path and no port', () => {
    expect(attached('http://cdp-host.test/json')('All CDP discovery methods failed for cdp-host.test:9222: refused', true))
      .toBe('All CDP discovery methods failed for BUCKLE_BROWSER_CDP: refused')
  })

  it('replaces a value as JSON writes it when that differs', () => {
    const endpoint = 'ws://127.0.0.1:9333/devtools/browser/never"shown'
    const scrubbed = attached(endpoint)(JSON.stringify({ success: false, error: `CDP connection failed: ${endpoint}` }), true)
    expect(scrubbed).toBe(JSON.stringify({ success: false, error: 'CDP connection failed: BUCKLE_BROWSER_CDP' }))
  })

  it('replaces a profile folder in the backslash spelling Chrome writes on Windows, and as JSON doubles it', () => {
    const scrub = settingScrubber({ kind: 'profile', directory: 'C:/Users/owner/never-shown' }, 'win32')
    const line = 'Failed to create C:\\Users\\owner\\never-shown\\SingletonLock'
    expect(scrub(line, true)).toBe('Failed to create BUCKLE_BROWSER_PROFILE\\SingletonLock')
    expect(scrub(JSON.stringify({ error: line }), true)).toBe(JSON.stringify({ error: 'Failed to create BUCKLE_BROWSER_PROFILE\\SingletonLock' }))
    expect(scrub('C:/Users/owner/never-shown/Default', false)).toBe('BUCKLE_BROWSER_PROFILE/Default')
  })
})
