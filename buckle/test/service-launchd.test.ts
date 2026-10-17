import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { createRuntimeOwner } from '@5straps/runtime'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { serviceCommand } from '../cli/service.js'
import { runProcess } from '../common/adapters/process-runner.js'
import { serviceManagerFor } from '../common/adapters/service-manager/index.js'
import { createLaunchdManager, LAUNCHCTL } from '../common/adapters/service-manager/launchd.js'
import { launchdAgentPath, launchdGuardedPaths, launchdLogPath, readAgent, renderAgent } from '../common/domain/launchd-agent.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { administersBuckleService, createCommandPolicyRule } from '../common/domain/permission/rules/command-policy-rule.js'
import { compilePolicy } from '../common/domain/policy.js'
import { protectedStateRoots } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { serviceInstalled } from '../common/services/node-service/installed.js'
import { holdServe, refusedServeExit, runningNode, SERVICE_MANAGERS, serviceDirectory } from '../common/services/node-service/serve-record.js'
import type { ProcessRequest, ProcessRunner } from '../common/types/ports/process-runner.js'
import { ServiceManagerError, type ServiceManager } from '../common/types/ports/service-manager.js'
import { leastProcessorTime, PROCESSOR_TIME_ROW_TIMEOUT } from './support/processor-time.js'
import { configFromEnvironment } from './support/workspace-config.js'

// D85 Q4, owner ruling of 2026-10-17 ("macOS find equivalent of Linux"): on macOS, a launchd agent, the counterpart of
// the systemd user unit. No launchd runs here or on CI, so the agent is checked as the text launchd reads, and launchctl
// is imitated at an injected path; no Mac has run any of it yet (known-limits-05).

const DEFINITION = { node: '/opt/node v24/bin/node', main: '/usr/local/lib/node_modules/@5straps/buckle/dist/main.js', stateDirectory: '/Users/owner/.5straps/buckle', environmentFile: null, path: '/Users/owner/.local/bin:/usr/local/bin:/usr/bin:/bin' }

describe('the launchd agent', () => {
  it('runs this Node and main.js with serve as separate strings, names where the node lives, and restarts on a failure alone', () => {
    expect(renderAgent(DEFINITION)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by buckle service install, which writes it again; buckle service uninstall removes it. -->
<!-- It names paths only: the node reads its settings from its own environment file. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.5straps.buckle</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/node v24/bin/node</string>
\t\t<string>/usr/local/lib/node_modules/@5straps/buckle/dist/main.js</string>
\t\t<string>serve</string>
\t\t<string>--service</string>
\t\t<string>launchd</string>
\t\t<string>--state-dir</string>
\t\t<string>/Users/owner/.5straps/buckle</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>/Users/owner/.5straps/buckle</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/Users/owner/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>/Users/owner/.5straps/buckle/logs/launchd.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/owner/.5straps/buckle/logs/launchd.log</string>
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>Umask</key>
\t<integer>63</integer>
</dict>
</plist>
`)
  })

  it('escapes each character XML reserves in every string, and reads odd paths back as they were', () => {
    const odd = { node: '/opt/Node & Co/bin/node', main: '/Users/o\'neil/<lib>/"x"\\main.js', stateDirectory: '/Users/zoë/state 100% > here', environmentFile: '/Users/zoë/a&b "c".env', path: '/opt/<p>:/usr/bin' }
    const agent = renderAgent(odd)
    expect(agent).toContain('\t\t<string>/opt/Node &amp; Co/bin/node</string>\n\t\t<string>/Users/o&apos;neil/&lt;lib&gt;/&quot;x&quot;\\main.js</string>\n')
    expect(agent).toContain('\t\t<string>--state-dir</string>\n\t\t<string>/Users/zoë/state 100% &gt; here</string>\n\t\t<string>--env-file</string>\n\t\t<string>/Users/zoë/a&amp;b &quot;c&quot;.env</string>\n\t</array>\n')
    expect(agent).toContain('\t<key>WorkingDirectory</key>\n\t<string>/Users/zoë/state 100% &gt; here</string>\n')
    expect(agent).toContain('\t\t<string>/opt/&lt;p&gt;:/usr/bin</string>\n')
    expect(agent).toContain('\t<string>/Users/zoë/state 100% &gt; here/logs/launchd.log</string>\n')
    // Every string element holds escaped text alone, so no path closes one early or opens another.
    for (const [, text] of agent.matchAll(/<string>([^<]*)<\/string>/g)) expect(text).not.toMatch(/[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/)
    expect(readAgent(agent)).toEqual({ node: odd.node, main: odd.main, stateDirectory: odd.stateDirectory, skipsOwnerOnlyCheck: false })
  })

  it('carries --skip-owner-only-check as the last argument where the install had it, and reads it back', () => {
    const skipped = renderAgent({ ...DEFINITION, environmentFile: '/srv/node.env', skipOwnerOnlyCheck: true })
    expect(skipped).toContain('\t\t<string>--env-file</string>\n\t\t<string>/srv/node.env</string>\n\t\t<string>--skip-owner-only-check</string>\n\t</array>\n')
    expect(readAgent(skipped)).toEqual({ node: DEFINITION.node, main: DEFINITION.main, stateDirectory: DEFINITION.stateDirectory, skipsOwnerOnlyCheck: true })
    expect(renderAgent({ ...DEFINITION, skipOwnerOnlyCheck: false })).toBe(renderAgent(DEFINITION))
  })

  it('names no environment where the shell had no PATH, and refuses a path holding a control character', () => {
    const { path: _none, ...noPath } = DEFINITION
    expect(renderAgent(noPath)).not.toContain('EnvironmentVariables')
    expect(() => renderAgent({ ...DEFINITION, stateDirectory: '/Users/owner/state\n</string><string>--evil' })).toThrow(new ServiceManagerError('A path the service would name holds a control character, so Buckle writes no agent for it'))
    expect(() => renderAgent({ ...DEFINITION, path: '/usr/bin\u007f' })).toThrow(ServiceManagerError)
  })

  it('reads an agent that does not say where its node lives as naming nothing, and numeric references as their characters', () => {
    expect(readAgent('<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/srv/main.js</string><string>serve</string></array></dict></plist>')).toEqual({ node: '/usr/bin/node', main: '/srv/main.js', stateDirectory: null, skipsOwnerOnlyCheck: false })
    expect(readAgent('<plist><dict><key>Label</key><string>com.5straps.buckle</string></dict></plist>')).toEqual({ node: null, main: null, stateDirectory: null, skipsOwnerOnlyCheck: false })
    expect(readAgent('<key>ProgramArguments</key>\n<array>\n<string>/usr/bin/node</string>\n<string>/srv/main.js</string>\n<string>--state-dir</string>\n<string>/Users/zo&#235;/&#x26;s</string>\n</array>').stateDirectory).toBe('/Users/zoë/&s')
  })

  it('lives where launchd reads the owner\'s agents, and is the one path the file tools refuse, with its log in the state directory', () => {
    expect(launchdAgentPath('/Users/owner')).toBe('/Users/owner/Library/LaunchAgents/com.5straps.buckle.plist')
    expect(launchdGuardedPaths('/Users/owner')).toEqual(['/Users/owner/Library/LaunchAgents/com.5straps.buckle.plist'])
    expect(launchdLogPath('/Users/owner/.5straps/buckle')).toBe('/Users/owner/.5straps/buckle/logs/launchd.log')
  })
})

/** What a node serving the state directory leaves for the service family: the lock, and its record under a pid of its own. */
async function serving(state: string, pid: number): Promise<{ pid: number; close(): Promise<void> }> {
  const owner = createRuntimeOwner({ name: 'launchd-node', services: [] })
  await holdServe({ stateDirectory: state, owner })
  writeFileSync(join(serviceDirectory(state), 'serve.json'), JSON.stringify({ pid, manager: 'launchd', version: '0.1.4', host: '127.0.0.1', port: 4320, startedAt: '2026-10-17T00:00:00.000Z' }))
  return { pid, close: () => owner.close() }
}

let nextPid = 910_000

interface FakeLaunchd {
  root: string
  state: string
  home: string
  main: string
  launchctl: string
  /** The words each launchctl call had, as the imitation recorded them. */
  calls(): string[]
  /** The environment each call ran with, as the imitation saw it. */
  environments(): string[]
  requests: ProcessRequest[]
  /** Runs the imitation, and plays launchd's part for the node: a load starts it (RunAtLoad), an unload ends it. */
  run: ProcessRunner
  /** The shell's own environment, with what a careless owner exports: none of it beyond the fixed list may reach launchctl. */
  environment: NodeJS.ProcessEnv
  mark(name: 'loaded' | 'disabled' | 'no-gui' | 'loaded-by-another' | 'slow', text?: string): void
  /** The node launchd runs now, if any. */
  node(): { pid: number; close(): Promise<void> } | null
  manager(location?: { stateDirectory: string; environmentFile: string | null }): ServiceManager
}

/**
 * A launchctl at a path of the test's own that records its words and environment and answers as launchd would: the
 * owner's login session (gui/501), the agent loaded or not, disabled or not, a bootstrap of a loaded agent refused as
 * already loaded, and, with the `slow` mark, a bootout that answers in progress (36) while two more prints still find it.
 */
function fakeLaunchd(options: { fail?: string } = {}): FakeLaunchd {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-launchd-')))
  const state = join(root, 'state')
  const home = join(root, 'home')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(home)
  writeFileSync(join(state, 'buckle.env'), 'BUCKLE_ADMIN_TOKEN=file-admin-fixture\n', { mode: 0o600 })
  const main = join(root, 'dist', 'main.js')
  mkdirSync(join(root, 'dist'))
  writeFileSync(main, '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.4' }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const launchctl = join(bin, 'launchctl')
  const marker = (name: string) => `'${join(root, name)}'`
  writeFileSync(launchctl, `#!/bin/sh
echo "$*" >> ${marker('calls')}
env >> ${marker('environments')}
echo -- >> ${marker('environments')}
case "$1" in
  ${options.fail ?? 'never-fails'}) exit 1 ;;
  print)
    if test "$2" = gui/501; then
      if test -f ${marker('no-gui')}; then echo 'Bad request.' >&2; echo 'Could not find domain for port identifier: 0x0' >&2; exit 112; fi
      echo 'gui/501 = {'; echo '}'; exit 0
    fi
    if test "$2" = gui/501/com.5straps.buckle && test -f ${marker('loaded')}; then echo 'gui/501/com.5straps.buckle = {'; echo '}'; exit 0; fi
    if test "$2" = gui/501/com.5straps.buckle && test -f ${marker('ending')}; then
      left=$(cat ${marker('ending')}); if test "$left" -gt 0; then echo $((left - 1)) > ${marker('ending')}; echo 'state = exiting'; exit 0; fi
      rm -f ${marker('ending')}
    fi
    echo 'Could not find service "com.5straps.buckle" in domain for port' >&2; exit 113 ;;
  print-disabled)
    echo 'disabled services = {'
    echo '	"com.apple.Siri.agent" => enabled'
    if test -f ${marker('disabled')}; then echo '	"com.5straps.buckle" => disabled'; fi
    echo '}'; exit 0 ;;
  enable) rm -f ${marker('disabled')}; exit 0 ;;
  bootstrap)
    if test -f ${marker('loaded')} || test -f ${marker('loaded-by-another')}; then rm -f ${marker('loaded-by-another')}; touch ${marker('loaded')}; echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi
    touch ${marker('loaded')}; exit 0 ;;
  bootout)
    if test -f ${marker('loaded')} && test -f ${marker('slow')}; then rm -f ${marker('loaded')}; echo 2 > ${marker('ending')}; echo 'Boot-out failed: 36: Operation now in progress' >&2; exit 36; fi
    if test -f ${marker('loaded')}; then rm -f ${marker('loaded')}; exit 0; fi
    echo 'Boot-out failed: 3: No such process' >&2; exit 3 ;;
  kickstart)
    if test -f ${marker('loaded')}; then exit 0; fi
    echo 'Could not find service "com.5straps.buckle" in domain for port' >&2; exit 113 ;;
esac
exit 0
`)
  chmodSync(launchctl, 0o755)
  // A launchctl first on PATH, which marks that it ran: the one at the injected path is the one run.
  const decoy = join(root, 'decoy')
  mkdirSync(decoy)
  writeFileSync(join(decoy, 'launchctl'), `#!/bin/sh\ntouch ${marker('decoy-ran')}\n`, { mode: 0o755 })
  const requests: ProcessRequest[] = []
  let node: { pid: number; close(): Promise<void> } | null = null
  const start = async () => { node ??= await serving(state, nextPid++) }
  const stop = async () => { await node?.close(); node = null }
  const read = (file: string) => existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : ''
  const environment: NodeJS.ProcessEnv = { PATH: `${decoy}:/usr/bin:/bin`, HOME: home, USER: 'owner', LANG: 'en_US.UTF-8', TMPDIR: root, BUCKLE_STATE_DIR: state, BUCKLE_ADMIN_TOKEN: 'shell-admin-fixture', GITHUB_TOKEN: 'shell-forge-fixture', XDG_RUNTIME_DIR: join(root, 'runtime'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture-bus' }
  const run: ProcessRunner = async request => {
    requests.push(request)
    const result = await runProcess(request)
    const [verb, ...rest] = request.args
    if (result.exitCode === 0 && verb === 'bootstrap') await start()
    if ((result.exitCode === 0 || result.exitCode === 36) && verb === 'bootout') await stop()
    if (result.exitCode === 0 && verb === 'kickstart') {
      if (rest.includes('-k')) await stop()
      await start()
    }
    return result
  }
  return {
    root, state, home, main, launchctl, requests, run, environment,
    calls: () => read('calls').split('\n').filter(Boolean),
    environments: () => read('environments').split('--\n').filter(Boolean),
    mark: (name, text = '') => writeFileSync(join(root, name), text),
    node: () => node,
    manager: (location = { stateDirectory: state, environmentFile: null }) => createLaunchdManager({ environment, run, location, launchctl, uid: 501, home }),
  }
}

/** The variables every child gets (buildChildEnvironment), as this test's shell sets them, and the ones /bin/sh adds itself. */
const FIXED = ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']
const SHELL_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

function expectFixedEnvironment(fake: FakeLaunchd): void {
  expect(fake.requests.length).toBeGreaterThan(0)
  for (const request of fake.requests) {
    expect(request).toMatchObject({ command: fake.launchctl, cwd: '/' })
    expect(Object.keys(request.environment).sort()).toEqual(FIXED)
  }
  for (const seen of fake.environments()) {
    const names = seen.split('\n').filter(Boolean).map(line => line.slice(0, line.indexOf('=')))
    expect(names.filter(name => !FIXED.includes(name) && !SHELL_OWN.has(name))).toEqual([])
    expect(seen).not.toMatch(/fixture|BUCKLE_|XDG_|DBUS_/)
  }
  expect(existsSync(join(fake.root, 'decoy-ran'))).toBe(false)
}

const AGENT = (fake: FakeLaunchd) => join(fake.home, 'Library', 'LaunchAgents', 'com.5straps.buckle.plist')
const SERVICE = 'gui/501/com.5straps.buckle'

describe.skipIf(process.platform === 'win32')('launchctl, imitated at an injected path', () => {
  it('installs: writes the agent owner-only in a folder it makes, enables it, and with now loads it, passing launchctl the fixed list alone', async () => {
    const fake = fakeLaunchd()
    const definition = { ...DEFINITION, stateDirectory: fake.state }
    await fake.manager().install(definition, { now: true })
    expect(readFileSync(AGENT(fake), 'utf8')).toBe(renderAgent(definition))
    expect(statSync(AGENT(fake)).mode & 0o777).toBe(0o600)
    expect(statSync(join(fake.home, 'Library', 'LaunchAgents')).mode & 0o777).toBe(0o700)
    expect(statSync(launchdLogPath(fake.state)).mode & 0o777).toBe(0o600)
    expect(fake.calls()).toEqual([`enable ${SERVICE}`, `bootout ${SERVICE}`, `print ${SERVICE}`, `bootstrap gui/501 ${AGENT(fake)}`])
    expect(fake.node()).not.toBeNull()
    expectFixedEnvironment(fake)
    await fake.node()?.close()
  })

  it('keeps the mode of a LaunchAgents folder that exists, and what the log already holds, and leaves the agent for the next login without now', async () => {
    const fake = fakeLaunchd()
    mkdirSync(join(fake.home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o755 })
    chmodSync(join(fake.home, 'Library', 'LaunchAgents'), 0o755)
    mkdirSync(join(fake.state, 'logs'), { mode: 0o700 })
    writeFileSync(launchdLogPath(fake.state), 'an earlier line\n', { mode: 0o600 })
    await fake.manager().install({ ...DEFINITION, stateDirectory: fake.state }, { now: false })
    expect(statSync(join(fake.home, 'Library', 'LaunchAgents')).mode & 0o777).toBe(0o755)
    expect(readFileSync(launchdLogPath(fake.state), 'utf8')).toBe('an earlier line\n')
    expect(fake.calls()).toEqual([`enable ${SERVICE}`])
    expect(fake.node()).toBeNull()
  })

  it('reads the installed agent back, enabled unless print-disabled lists it, and tells this node\'s agent from another\'s', async () => {
    const fake = fakeLaunchd()
    const launchd = fake.manager()
    expect(await launchd.installed()).toBeNull()
    expect(fake.calls()).toEqual([])
    await launchd.install({ ...DEFINITION, stateDirectory: fake.state, skipOwnerOnlyCheck: true }, { now: false })
    expect(await launchd.installed()).toEqual({ node: DEFINITION.node, main: DEFINITION.main, thisNode: true, enabled: true, skipsOwnerOnlyCheck: true })
    fake.mark('disabled')
    expect(await launchd.installed()).toMatchObject({ enabled: false })
    expect(await fake.manager({ stateDirectory: join(fake.root, 'other'), environmentFile: null }).installed()).toMatchObject({ thisNode: false })
    writeFileSync(AGENT(fake), '<plist><dict><key>Label</key><string>com.5straps.buckle</string></dict></plist>')
    expect(await launchd.installed()).toEqual({ node: null, main: null, thisNode: null, enabled: false })
    expect(fake.calls().filter(call => call.startsWith('print-disabled'))).toEqual(['print-disabled gui/501', 'print-disabled gui/501', 'print-disabled gui/501', 'print-disabled gui/501'])
  })

  it('starts by loading the agent afresh, stops by unloading it, restarts the same way, and removes it unloaded', async () => {
    const fake = fakeLaunchd()
    const launchd = fake.manager()
    await launchd.install({ ...DEFINITION, stateDirectory: fake.state }, { now: false })
    await launchd.start()
    const first = fake.node()!.pid
    await launchd.restart!()
    expect(fake.node()!.pid).not.toBe(first)
    await launchd.stop!()
    expect(fake.node()).toBeNull()
    await launchd.uninstall()
    expect(existsSync(AGENT(fake))).toBe(false)
    expect(fake.calls()).toEqual([
      `enable ${SERVICE}`,
      `bootout ${SERVICE}`, `print ${SERVICE}`, `bootstrap gui/501 ${AGENT(fake)}`,
      `bootout ${SERVICE}`, `print ${SERVICE}`, `bootstrap gui/501 ${AGENT(fake)}`,
      `bootout ${SERVICE}`, `print ${SERVICE}`,
      `bootout ${SERVICE}`, `print ${SERVICE}`,
    ])
    expect(launchd.beforeLogin).toBeUndefined()
  })

  it('waits for an unload launchctl answered before the node ended, and starts a loaded agent where launchd answers it is already loaded', async () => {
    const fake = fakeLaunchd()
    const launchd = fake.manager()
    await launchd.install({ ...DEFINITION, stateDirectory: fake.state }, { now: true })
    fake.mark('slow')
    await launchd.stop!()
    expect(fake.calls().slice(-4)).toEqual([`bootout ${SERVICE}`, `print ${SERVICE}`, `print ${SERVICE}`, `print ${SERVICE}`])
    // Something else loads it between the unload and the load, as a login would: that load is the file's, so it is started.
    fake.mark('loaded-by-another')
    await launchd.start()
    expect(fake.calls().slice(-5)).toEqual([`bootout ${SERVICE}`, `print ${SERVICE}`, `bootstrap gui/501 ${AGENT(fake)}`, `print ${SERVICE}`, `kickstart ${SERVICE}`])
    expect(fake.node()).not.toBeNull()
    await fake.node()?.close()
  })

  it('says no launchd login session answers where launchctl is missing at its path or gui/<uid> does not answer', async () => {
    const fake = fakeLaunchd()
    expect(await fake.manager().unavailable()).toBeNull()
    expect(fake.calls()).toEqual(['print gui/501'])
    expect(await createLaunchdManager({ environment: fake.environment, run: fake.run, location: { stateDirectory: fake.state, environmentFile: null }, launchctl: join(fake.root, 'none', 'launchctl'), uid: 501, home: fake.home }).unavailable())
      .toBe('No launchd login session answers here (launchctl is missing)')
    fake.mark('no-gui')
    expect(await fake.manager().unavailable()).toBe('No launchd login session answers here (launchctl print gui/501 failed): this user has not logged in at the Mac, as over SSH before a login')
    expect(LAUNCHCTL).toBe('/bin/launchctl')
  })

  it('refuses where a launchctl call fails, naming the verb, its exit code, and where to look, and no path', async () => {
    const enabling = fakeLaunchd({ fail: 'enable' })
    const refused = enabling.manager().install({ ...DEFINITION, stateDirectory: enabling.state }, { now: false })
    await expect(refused).rejects.toThrow(new ServiceManagerError('launchctl enable failed (exit code 1); launchctl print gui/501/com.5straps.buckle says why'))
    const loading = fakeLaunchd({ fail: 'bootstrap' })
    const error = await loading.manager().install({ ...DEFINITION, stateDirectory: loading.state }, { now: true }).catch((caught: unknown) => caught)
    expect(error).toEqual(new ServiceManagerError('launchctl bootstrap failed (exit code 1); launchctl print gui/501/com.5straps.buckle says why'))
    expect(String(error)).not.toContain(loading.root)
  })
})

describe('the service manager on macOS', () => {
  it('is launchd, driven at launchctl\'s absolute path', () => {
    const context = { environment: {}, run: runProcess, location: { stateDirectory: '/srv/state', environmentFile: null } }
    expect(serviceManagerFor({ ...context, platform: 'darwin' })).toMatchObject({ kind: 'launchd', label: 'the launchd agent com.5straps.buckle' })
  })
})

describe.skipIf(process.platform === 'win32')('buckle service on macOS, with launchctl imitated', () => {
  async function service(fake: FakeLaunchd, argv: string[], environment: NodeJS.ProcessEnv = fake.environment) {
    let out = ''
    let err = ''
    const result = await serviceCommand({ argv, environment, platform: 'darwin', cwd: fake.root, run: fake.run, mainScript: fake.main, manager: location => createLaunchdManager({ environment, run: fake.run, location, launchctl: fake.launchctl, uid: 501, home: fake.home }), out: text => { out += text }, err: text => { err += text } })
    return { ...result, out, err }
  }

  it('installs, starts, stops, restarts, and removes the agent, and status names no start before login', async () => {
    const fake = fakeLaunchd()
    expect(await service(fake, ['install'])).toMatchObject({ exitCode: 0, out: 'Installed the Buckle service (the launchd agent com.5straps.buckle); it starts at every login. Start it now with buckle service start.\n', err: '' })
    expect(readAgent(readFileSync(AGENT(fake), 'utf8'))).toEqual({ node: process.execPath, main: fake.main, stateDirectory: fake.state, skipsOwnerOnlyCheck: false })
    expect(readFileSync(AGENT(fake), 'utf8')).toContain(`\t\t<key>PATH</key>\n\t\t<string>${fake.environment.PATH}</string>\n`)
    expect((await service(fake, ['status'])).out).toBe('Service    the launchd agent com.5straps.buckle, starts at login\nRunning    no\nVersion    0.1.4 installed\n')

    const started = await service(fake, ['start'])
    expect(started).toMatchObject({ exitCode: 0, out: `Started the Buckle service (pid ${fake.node()!.pid}) at http://127.0.0.1:4320.\n` })
    expect((await service(fake, ['start'])).out).toBe(`The Buckle service is already running (pid ${fake.node()!.pid}).\n`)
    const shown = await service(fake, ['status'])
    expect(shown.out).toContain(`Running    yes (pid ${fake.node()!.pid}), started by launchd at 2026-10-17T00:00:00.000Z\n`)
    expect(shown.out).not.toMatch(/Next|before anyone logs in|boot/)
    expect(JSON.parse((await service(fake, ['status', '--json'])).out)).toMatchObject({ platform: 'darwin', manager: 'launchd', definition: { label: 'the launchd agent com.5straps.buckle', enabled: true, thisNode: true }, running: { startedBy: 'launchd' }, next: [] })
    expect(JSON.parse((await service(fake, ['status', '--json'])).out).definition).not.toHaveProperty('startsBeforeLogin')

    const first = fake.node()!.pid
    const restarted = await service(fake, ['restart'])
    expect(restarted).toMatchObject({ exitCode: 0, out: `Restarted the Buckle service (pid ${fake.node()!.pid}) at http://127.0.0.1:4320.\n` })
    expect(fake.node()!.pid).not.toBe(first)
    const second = fake.node()!.pid
    expect(await service(fake, ['stop'])).toMatchObject({ exitCode: 0, out: `Stopped Buckle (pid ${second}).\n` })
    expect(await runningNode(fake.state)).toBeNull()
    expect(await service(fake, ['uninstall'])).toMatchObject({ exitCode: 0, out: 'Removed the Buckle service (the launchd agent com.5straps.buckle); the state directory is kept.\n' })
    expect(existsSync(AGENT(fake))).toBe(false)
    expectFixedEnvironment(fake)
  })

  it('replaces an earlier install\'s node with install --now, as systemctl restart does', async () => {
    const fake = fakeLaunchd()
    const installed = await service(fake, ['install', '--now'])
    expect(installed).toMatchObject({ exitCode: 0, err: '' })
    const first = fake.node()!.pid
    expect(installed.out).toBe(`Installed and started the Buckle service (the launchd agent com.5straps.buckle, pid ${first}); it starts at every login.\n`)
    let out = ''
    const again = await serviceCommand({ argv: ['install', '--now'], environment: fake.environment, platform: 'darwin', cwd: fake.root, run: fake.run, mainScript: fake.main, skipOwnerOnlyCheck: true,
      manager: location => createLaunchdManager({ environment: fake.environment, run: fake.run, location, launchctl: fake.launchctl, uid: 501, home: fake.home }), out: text => { out += text }, err: text => { out += text } })
    expect(again.exitCode).toBe(0)
    const second = fake.node()!.pid
    expect(second).not.toBe(first)
    expect(out).toBe(`Installed and started the Buckle service (the launchd agent com.5straps.buckle, pid ${second}); it starts at every login.\n`)
    expect(readAgent(readFileSync(AGENT(fake), 'utf8')).skipsOwnerOnlyCheck).toBe(true)
    expect(fake.calls().slice(-4)).toEqual([`enable ${SERVICE}`, `bootout ${SERVICE}`, `print ${SERVICE}`, `bootstrap gui/501 ${AGENT(fake)}`])
    await service(fake, ['stop'])
  })

  // Fix brief 7, item 1: a node that fails at every start holds the serve lock only while it runs, and launchd starts it
  // again five seconds after each failure, so stop acts on the agent installed for this node whether a node holds the lock or not.
  it('unloads this node\'s agent when no node runs, as between the failed starts launchd repeats, and touches no other agent', async () => {
    const fake = fakeLaunchd()
    await service(fake, ['install'])
    fake.mark('loaded')
    const before = fake.calls().length
    expect(await service(fake, ['stop'])).toMatchObject({ exitCode: 0, out: 'Stopped the Buckle service (the launchd agent com.5straps.buckle); no node was running.\n', err: '' })
    expect(fake.calls().slice(before)).toEqual(['print-disabled gui/501', `bootout ${SERVICE}`, `print ${SERVICE}`])
    expect(existsSync(join(fake.root, 'loaded'))).toBe(false)
    const entries = readFileSync(join(fake.state, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; event: string; outcome: string; detail?: string })
    expect(entries).toContainEqual(expect.objectContaining({ tool: 'cli_service', event: 'result', outcome: 'ok', detail: 'stop launchd' }))

    // Another state directory's agent, and an agent that does not say which, are not this node's to unload.
    for (const plist of [renderAgent({ ...DEFINITION, stateDirectory: join(fake.root, 'other-state') }), '<plist><dict><key>Label</key><string>com.5straps.buckle</string></dict></plist>']) {
      const other = fakeLaunchd()
      mkdirSync(join(other.home, 'Library', 'LaunchAgents'), { recursive: true })
      writeFileSync(AGENT(other), plist)
      other.mark('loaded')
      expect(await service(other, ['stop'])).toMatchObject({ exitCode: 0, out: 'Buckle is not running.\n', err: '' })
      expect(other.calls().filter(call => /^(bootout|bootstrap|kickstart|enable)/.test(call))).toEqual([])
      expect(existsSync(join(other.root, 'loaded'))).toBe(true)
    }

    // A node that holds the lock and has not published its record yet is still starting: stop asks nothing of the agent.
    const starting = fakeLaunchd()
    await service(starting, ['install'])
    starting.mark('loaded')
    const owner = createRuntimeOwner({ name: 'starting-node', services: [] })
    await holdServe({ stateDirectory: starting.state, owner })
    try {
      expect(await service(starting, ['stop'])).toMatchObject({ exitCode: 1, out: '', err: 'Buckle is still starting; run buckle service stop again in a moment.\n' })
      expect(starting.calls().filter(call => call.startsWith('bootout'))).toEqual([])
    } finally { await owner.close() }
  })

  it('refuses to install with no buckle.env, beside another node\'s agent, beside a serve at a terminal, and with no login session', async () => {
    const fresh = fakeLaunchd()
    rmSync(join(fresh.state, 'buckle.env'))
    expect(await service(fresh, ['install'])).toMatchObject({ exitCode: 1, err: 'This node is not set up yet, and a service reads its settings from its environment file: run buckle init first.\n' })
    expect(existsSync(AGENT(fresh))).toBe(false)

    const other = fakeLaunchd()
    mkdirSync(join(other.home, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(AGENT(other), renderAgent({ ...DEFINITION, stateDirectory: join(other.root, 'other-state') }))
    const refused = await service(other, ['install', '--now'])
    expect(refused).toMatchObject({ exitCode: 1, err: 'A Buckle service for another state directory is installed, and this machine runs one service. Remove it with buckle service uninstall, then install this node\'s.\n' })
    expect(refused.err).not.toContain(other.root)

    const terminal = fakeLaunchd()
    const owner = createRuntimeOwner({ name: 'terminal-node', services: [] })
    const hold = await holdServe({ stateDirectory: terminal.state, owner })
    await hold.publish({ manager: 'terminal', version: '0.1.4', host: '127.0.0.1', port: 4320 })
    try {
      expect(await service(terminal, ['install', '--now'])).toMatchObject({ exitCode: 1, err: `Buckle runs at a terminal (pid ${process.pid}); stop it there with Ctrl-C, then run buckle service install --now again.\n` })
      expect(terminal.calls().filter(call => /^(bootstrap|bootout|kickstart|enable)/.test(call))).toEqual([])
    } finally { await owner.close() }

    const away = fakeLaunchd()
    away.mark('no-gui')
    expect(await service(away, ['install', '--now'])).toMatchObject({ exitCode: 1, err: 'No launchd login session answers here (launchctl print gui/501 failed): this user has not logged in at the Mac, as over SSH before a login, so nothing was installed; buckle serve --background runs the node until it stops.\n' })
    expect(existsSync(AGENT(away))).toBe(false)
  })

  it('shows a disabled agent as disabled, and enables it again on install', async () => {
    const fake = fakeLaunchd()
    await service(fake, ['install'])
    fake.mark('disabled')
    expect((await service(fake, ['status'])).out).toContain('Service    the launchd agent com.5straps.buckle, disabled\n')
    await service(fake, ['install'])
    expect((await service(fake, ['status'])).out).toContain('Service    the launchd agent com.5straps.buckle, starts at login\n')
  })
})

describe('whether a launchd agent runs this node', () => {
  it('is the agent naming this state directory, read from disk, and no other', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-launchd-installed-')))
    const state = join(root, 'state')
    mkdirSync(state, { mode: 0o700 })
    expect(serviceInstalled(state, {}, 'darwin', root)).toBe(false)
    mkdirSync(join(root, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(launchdAgentPath(root), renderAgent({ ...DEFINITION, stateDirectory: join(root, 'other-state') }))
    expect(serviceInstalled(state, {}, 'darwin', root)).toBe(false)
    writeFileSync(launchdAgentPath(root), renderAgent({ ...DEFINITION, stateDirectory: state }))
    expect(serviceInstalled(state, {}, 'darwin', root)).toBe(true)
    expect(serviceInstalled(state, {}, 'linux', root)).toBe(false)
  })
})

// The agent's property list joins Buckle's own state on macOS, as the unit does on Linux, so no file tool rewrites what
// runs at the next login.
describe('the agent that starts Buckle at login', () => {
  it('is among the protected state roots on macOS alone', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-launchd-home-')))
    vi.stubEnv('HOME', home)
    try {
      expect(protectedStateRoots({ stateDirectory: '/srv/state' }, 'darwin', {})).toEqual(expect.arrayContaining([join(home, 'Library', 'LaunchAgents', 'com.5straps.buckle.plist')]))
      expect(protectedStateRoots({ stateDirectory: '/srv/state' }, 'linux', {}).join()).not.toContain('LaunchAgents')
      expect(protectedStateRoots({ stateDirectory: '/srv/state' }, 'darwin', { XDG_CONFIG_HOME: join(home, 'cfg') }).join()).not.toContain('systemd')
    } finally { vi.unstubAllEnvs() }
  })
})

function evaluate(command: string, args: string[]) {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = ['*', 'bash -c *']
  const engine = createPermissionEngine([createCommandPolicyRule(compilePolicy(policy))])
  return engine.evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command, args }], grants: { subjectsFor: () => [] } })
}

// The self-administration guard (fix brief 6, item 8) on macOS: launchctl reaches the agent that runs Buckle at login.
describe('a shell command on Buckle\'s own launchd agent', () => {
  it.each([
    ['launchctl', ['bootout', 'gui/501/com.5straps.buckle']],
    ['launchctl', ['kickstart', '-k', 'gui/501/com.5straps.buckle']],
    ['launchctl', ['unload', '~/Library/LaunchAgents/com.5straps.buckle.plist']],
    ['/bin/launchctl', ['bootstrap', 'gui/501', '/Users/owner/Library/LaunchAgents/com.5straps.buckle.plist']],
    ['launchctl', ['disable', "'gui/501/com.5straps.buckle'"]],
    ['launchctl', ['remove', 'com.5straps.buckle']],
    ['bash', ['-c', 'cd /tmp && launchctl kill SIGTERM gui/$UID/com.5straps.buckle']],
  ] as Array<[string, string[]]>)('refuses %s %j, which reaches Buckle\'s own agent', (command, args) => {
    const outcome = evaluate(command, args)
    expect(outcome.kind === 'deny' ? outcome.denial.reason : '').toBe('A tool cannot administer the Buckle that runs it')
  })

  // gui/$(id -u)/<label> is how the launchctl man page and most guides name a service in the login session; the
  // substitution's parentheses cut the line into statements, which left the label in one apart from launchctl.
  it.each([
    ['bash', ['-c', 'launchctl kickstart -k gui/$(id -u)/com.5straps.buckle']],
    ['bash', ['-c', 'cd /tmp && launchctl bootout "gui/$(id -u)/com.5straps.buckle"']],
    ['bash', ['-c', 'launchctl bootout gui/`id -u`/com.5straps.buckle']],
    ['bash', ['-c', 'systemctl --user stop $(echo) buckle.service']],
  ] as Array<[string, string[]]>)('refuses %s %j, a command substitution inside the line', (command, args) => {
    const outcome = evaluate(command, args)
    expect(outcome.kind === 'deny' ? outcome.denial.reason : '').toBe('A tool cannot administer the Buckle that runs it')
  })

  it.each([
    ['bash', ['-c', 'echo $(launchctl list) com.5straps.buckle']],
    ['bash', ['-c', 'launchctl list; echo $(id -u) com.5straps.buckle']],
  ] as Array<[string, string[]]>)('leaves %s %j alone, where no launchctl statement names the agent', (command, args) => {
    expect(evaluate(command, args).kind).not.toBe('deny')
  })

  // About 100 KB, the most one shell_exec argument holds, of substitutions that never close.
  it('reads a long line of substitutions in well under a second', () => {
    const { milliseconds, result } = leastProcessorTime(() => administersBuckleService(`launchctl bootout gui/$(id -u)/com.5straps.buckle${' $(id -u'.repeat(7_000)}${' `id'.repeat(7_001)}`))
    expect(milliseconds).toBeLessThan(250)
    expect(result).toBe(true)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it.each([
    ['launchctl', ['list']],
    ['launchctl', ['print', 'gui/501/com.example.agent']],
    ['launchctl', ['bootout', 'gui/501/com.5straps.buckle-docs']],
    ['bash', ['-c', 'launchctl list | grep buckle']],
    ['echo', ['com.5straps.buckle']],
  ] as Array<[string, string[]]>)('leaves %s %j alone, which names nothing of Buckle\'s', (command, args) => {
    expect(evaluate(command, args).kind).not.toBe('deny')
  })

  it.skipIf(process.platform === 'win32')('is refused before it runs, and audited as a denial', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-launchd-command-')))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    // A launchctl of the test's own, found first on PATH, which marks that it ran.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\ntouch '${join(root, 'ran')}'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'shell' }) })
    try {
      const refused = await runtime.invoke({ request: { requestId: 'agent-bootout', tool: 'shell_exec', args: { command: 'launchctl', args: ['bootout', 'gui/501/com.5straps.buckle'] }, approvalTokens: [] }, sessionId: 'launchd' })
      expect(refused).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'A tool cannot administer the Buckle that runs it' } })
      expect(runtime.actions.read(20).filter(entry => entry.event === 'result')).toContainEqual(expect.objectContaining({ requestId: 'agent-bootout', outcome: 'denied' }))
      expect(existsSync(join(root, 'ran'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  })
})

// Phase 3b, item 3: launchd restarts every failed exit, so a serve it started that finds another node serving exits 0,
// which launchd leaves, where the unit's exits 2, which the unit does not restart on. The built CLI is run on both in
// test/http/service-systemd.test.ts.
describe('the exit of a serve refused beside another node', () => {
  it('is 0 under launchd alone, and 2 under every other manager and at a terminal', () => {
    expect(refusedServeExit('launchd')).toBe(0)
    for (const manager of SERVICE_MANAGERS.filter(kind => kind !== 'launchd')) expect(refusedServeExit(manager)).toBe(2)
    expect(refusedServeExit(null)).toBe(2)
  })
})
