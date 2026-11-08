import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it, vi } from 'vitest'
import { protectedStateRoots } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { serviceCommand } from '../cli/service.js'
import { runProcess } from '../common/adapters/process-runner.js'
import { createSystemdManager } from '../common/adapters/service-manager/systemd.js'
import { readUnit, renderUnit, systemdGuardedPaths, systemdUnitDirectory, systemdUnitPaths } from '../common/domain/systemd-unit.js'
import { ServiceManagerError } from '../common/types/ports/service-manager.js'
import { auditEntries } from './support/action-log-writer.js'

// Phase 3, item 2 of the workspace-model slice (Q4): on Linux, a systemd user unit. No systemd user session runs here
// or on CI, so a fake systemctl on PATH records each call's words and environment, and answers as the user manager
// would; the unit is checked as text.

const DEFINITION = { node: '/opt/node v24/bin/node', main: '/opt/lib/node_modules/@5straps/buckle/dist/main.js', stateDirectory: '/home/owner/.5straps/buckle', environmentFile: null, path: '/home/owner/.local/bin:/usr/bin:/bin' }

describe('the systemd user unit', () => {
  it('runs this Node and main.js with serve, names where the node lives as paths, and restarts on a failure alone', () => {
    expect(renderUnit(DEFINITION)).toBe(`# Written by buckle service install, which writes it again; buckle service uninstall removes it.
# It names paths only: the node reads its settings from its own environment file.
[Unit]
Description=5straps Buckle, the local permission node

[Service]
Type=simple
ExecStart="/opt/node v24/bin/node" "/opt/lib/node_modules/@5straps/buckle/dist/main.js" serve --service systemd --state-dir "/home/owner/.5straps/buckle"
Environment="PATH=/home/owner/.local/bin:/usr/bin:/bin"
WorkingDirectory=/home/owner/.5straps/buckle
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=2
KillSignal=SIGTERM
UMask=0077

[Install]
WantedBy=default.target
`)
  })

  it('quotes what systemd would read otherwise, a specifier\'s %, a variable\'s $, a quote, and a backslash, and reads them back', () => {
    const odd = { node: '/opt/n%h/node', main: '/opt/$HOME/"x"\\main.js', stateDirectory: '/srv/state 100%', environmentFile: '/srv/node$.env', path: '/opt/%t:/usr/bin' }
    const unit = renderUnit(odd)
    expect(unit).toContain('ExecStart="/opt/n%%h/node" "/opt/$$HOME/\\"x\\"\\\\main.js" serve --service systemd --state-dir "/srv/state 100%%" --env-file "/srv/node$$.env"\n')
    expect(unit).toContain('Environment="PATH=/opt/%%t:/usr/bin"\n')
    expect(unit).toContain('WorkingDirectory=/srv/state 100%%\n')
    expect(readUnit(unit)).toEqual({ node: odd.node, main: odd.main, stateDirectory: odd.stateDirectory, skipsOwnerOnlyCheck: false })
  })

  // Finding 18 of recheck 4: a node whose state directory modes cannot be set refused it at every start, as the unit had no flag.
  it('carries --skip-owner-only-check at the end of ExecStart where the install had it, and reads it back', () => {
    const skipped = renderUnit({ ...DEFINITION, environmentFile: '/srv/node.env', skipOwnerOnlyCheck: true })
    expect(skipped).toContain('serve --service systemd --state-dir "/home/owner/.5straps/buckle" --env-file "/srv/node.env" --skip-owner-only-check\n')
    expect(readUnit(skipped)).toMatchObject({ stateDirectory: '/home/owner/.5straps/buckle', skipsOwnerOnlyCheck: true })
    expect(renderUnit(DEFINITION)).not.toContain('skip-owner-only-check')
    expect(renderUnit({ ...DEFINITION, skipOwnerOnlyCheck: false })).toBe(renderUnit(DEFINITION))
  })

  it('names no PATH where the shell had none, and refuses a path holding a control character', () => {
    expect(renderUnit({ ...DEFINITION, path: undefined } as never)).not.toContain('Environment=')
    expect(() => renderUnit({ ...DEFINITION, stateDirectory: '/srv/state\nExecStartPre=/bin/evil' })).toThrow(new ServiceManagerError('A path the service would name holds a control character, so Buckle writes no unit for it'))
  })

  it('reads a unit that does not say where its node lives as naming nothing', () => {
    expect(readUnit('[Service]\nExecStart=/usr/bin/node /srv/main.js serve\n')).toEqual({ node: '/usr/bin/node', main: '/srv/main.js', stateDirectory: null, skipsOwnerOnlyCheck: false })
    expect(readUnit('[Unit]\n')).toEqual({ node: null, main: null, stateDirectory: null, skipsOwnerOnlyCheck: false })
  })

  it('lives where the user manager reads the owner\'s units, beside the link enable makes', () => {
    expect(systemdUnitDirectory({}, '/home/owner')).toBe('/home/owner/.config/systemd/user')
    expect(systemdUnitDirectory({ XDG_CONFIG_HOME: '/home/owner/cfg' }, '/home/owner')).toBe('/home/owner/cfg/systemd/user')
    expect(systemdUnitDirectory({ XDG_CONFIG_HOME: 'cfg' }, '/home/owner')).toBe('/home/owner/.config/systemd/user')
    expect(systemdUnitPaths({}, '/home/owner')).toEqual(['/home/owner/.config/systemd/user/buckle.service', '/home/owner/.config/systemd/user/default.target.wants/buckle.service'])
  })
})

// Phase 3, item 6: the unit and its enablement link join Buckle's own state, so no file tool rewrites what runs at login.
describe.skipIf(process.platform === 'win32')('the unit that starts Buckle at login', () => {
  it('is among the protected state roots on Linux alone', () => {
    const roots = protectedStateRoots({ stateDirectory: '/srv/state' }, 'linux', { XDG_CONFIG_HOME: '/home/owner/cfg' })
    expect(roots).toEqual(expect.arrayContaining(['/home/owner/cfg/systemd/user/buckle.service', '/home/owner/cfg/systemd/user/default.target.wants/buckle.service']))
    expect(protectedStateRoots({ stateDirectory: '/srv/state' }, 'darwin', { XDG_CONFIG_HOME: '/home/owner/cfg' }).join()).not.toContain('systemd')
  })

  // Fix brief 6, item 4 (findings 17 and 29 of recheck 4): systemd also reads the unit's drop-ins, and a unit of the same
  // name in user.control, which it reads first; either changes what runs at the next login, so each joins the unit.
  it('takes in its drop-in folder and the user.control copy and its drop-ins, and the installer still writes the unit alone', () => {
    expect(systemdGuardedPaths({}, '/home/owner')).toEqual([
      '/home/owner/.config/systemd/user/buckle.service', '/home/owner/.config/systemd/user/default.target.wants/buckle.service',
      '/home/owner/.config/systemd/user/buckle.service.d', '/home/owner/.config/systemd/user.control/buckle.service', '/home/owner/.config/systemd/user.control/buckle.service.d',
    ])
    expect(systemdUnitPaths({}, '/home/owner')).toHaveLength(2)
    expect(protectedStateRoots({ stateDirectory: '/srv/state' }, 'linux', { XDG_CONFIG_HOME: '/home/owner/cfg' })).toEqual(expect.arrayContaining(systemdGuardedPaths({ XDG_CONFIG_HOME: '/home/owner/cfg' }, '/home/owner')))
  })

  it('refuses a drop-in, or a user.control unit, to the file tools, even past an always grant over the folder holding them', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-unit-dropin-')))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'))
    try {
      const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_AUTH_TOKEN: 'unit-agent', BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false' }) })
      await runtime.grants.grant({ sessionId: 'unit', rule: 'write_scope', subject: root, scope: 'always' })
      const write = (path: string) => runtime.invoke({ request: { requestId: crypto.randomUUID(), tool: 'fs_write', args: { path, content: '[Service]\nExecStart=\nExecStart=/bin/sh -c evil\nEnvironment=BUCKLE_HOST=0.0.0.0\n', createParents: true }, approvalTokens: [] }, sessionId: 'unit' })
      // The grant opens an ordinary file beside them, so the refusals below are the unit's own.
      expect(await write(join(root, 'config', 'systemd', 'user', 'other.service'))).toMatchObject({ outcome: 'ok' })
      for (const path of [join(root, 'config', 'systemd', 'user', 'buckle.service.d', 'override.conf'), join(root, 'config', 'systemd', 'user.control', 'buckle.service'), join(root, 'config', 'systemd', 'user.control', 'buckle.service.d', 'override.conf')]) {
        expect(await write(path)).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Buckle\'s own state') } })
      }
      expect(existsSync(join(root, 'config', 'systemd', 'user', 'buckle.service.d'))).toBe(false)
      expect(existsSync(join(root, 'config', 'systemd', 'user.control'))).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it('is refused to the file tools, read or written, as Buckle\'s own state', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-unit-protected-')))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'))
    try {
      const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_AUTH_TOKEN: 'unit-agent', BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false' }) })
      const call = (tool: string, args: Record<string, string>) => runtime.invoke({ request: { requestId: crypto.randomUUID(), tool, args, approvalTokens: [] }, sessionId: 'unit' })
      for (const path of systemdUnitPaths({ XDG_CONFIG_HOME: join(root, 'config') }, root)) {
        expect(await call('fs_write', { path, content: '[Service]\nExecStart=/bin/sh -c evil\n' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Buckle\'s own state') } })
        expect(await call('fs_read', { path })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
      }
      expect(existsSync(join(root, 'config', 'systemd'))).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })
})

// Fix brief 6, item 8: a shell command that reaches Buckle's unit or task through the service manager is refused as
// `buckle service` would be, before anything runs, and the refusal is audited as every denial is.
describe('a shell command on Buckle\'s own unit', () => {
  it('is refused before it runs, and audited as a denial', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-unit-command-')))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    // A systemctl of the test's own, found first on PATH, which marks that it ran: the host's is never reached.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\ntouch '${join(root, 'ran')}'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'shell' }) })
    try {
      const refused = await runtime.invoke({ request: { requestId: 'unit-stop', tool: 'shell_exec', args: { command: 'systemctl', args: ['--user', 'stop', 'buckle.service'] }, approvalTokens: [] }, sessionId: 'unit' })
      expect(refused).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'A tool cannot administer the Buckle that runs it. Only the owner can administer Buckle from their own terminal. A tool approval or allow rule cannot enable this action.' } })
      const audited = (await auditEntries(runtime.actions, 20)).filter(entry => entry.event === 'result')
      expect(audited, JSON.stringify(audited)).toContainEqual(expect.objectContaining({ requestId: 'unit-stop', outcome: 'denied' }))
      expect(existsSync(join(root, 'ran'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  })
})

interface FakeSystemd { root: string; bin: string; calls(): string[]; environments(): string[]; environment: NodeJS.ProcessEnv }

/** A systemctl on PATH that records its words and environment, and answers `show` and `is-*` from `answers`. */
function fakeSystemd(answers: { show?: number; enabled?: boolean; active?: boolean; fail?: string } = {}): FakeSystemd {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-systemd-')))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'runtime'))
  const calls = join(root, 'calls')
  const environments = join(root, 'environments')
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> '${calls}'
env >> '${environments}'
echo '--' >> '${environments}'
case "$2" in
  ${answers.fail ?? 'never-fails'}) exit 1 ;;
  show) echo Version=255; exit ${answers.show ?? 0} ;;
  is-enabled) exit ${answers.enabled === false ? 1 : 0} ;;
  is-active) exit ${answers.active === false ? 3 : 0} ;;
esac
exit 0
`)
  chmodSync(join(bin, 'systemctl'), 0o755)
  const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : ''
  return {
    root, bin,
    calls: () => read(calls).split('\n').filter(Boolean),
    environments: () => read(environments).split('--\n').filter(Boolean),
    // The shell's own environment, which holds what a careless owner exports: none of it may reach systemctl.
    environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, XDG_RUNTIME_DIR: join(root, 'runtime'), XDG_CONFIG_HOME: join(root, 'config'), BUCKLE_ADMIN_TOKEN: 'shell-admin-fixture', AWS_SECRET_ACCESS_KEY: 'shell-cloud-fixture', BUCKLE_STATE_DIR: join(root, 'state') },
  }
}

function manager(fake: FakeSystemd, environment: NodeJS.ProcessEnv = fake.environment) {
  return createSystemdManager({ environment, run: runProcess, location: { stateDirectory: join(fake.root, 'state'), environmentFile: null }, home: fake.root, cwd: fake.root })
}

describe.skipIf(process.platform === 'win32')('systemctl --user, imitated on PATH', () => {
  it('installs: writes the unit owner-only, reloads, enables, and restarts with now, passing no credential to systemctl', async () => {
    const fake = fakeSystemd()
    await manager(fake).install({ ...DEFINITION, stateDirectory: join(fake.root, 'state') }, { now: true })
    const unit = join(fake.root, 'config', 'systemd', 'user', 'buckle.service')
    expect(readFileSync(unit, 'utf8')).toBe(renderUnit({ ...DEFINITION, stateDirectory: join(fake.root, 'state') }))
    expect(statSync(unit).mode & 0o777).toBe(0o600)
    expect(fake.calls()).toEqual(['--user daemon-reload', '--user enable buckle.service', '--user restart buckle.service'])
    for (const environment of fake.environments()) {
      expect(environment).toContain(`XDG_RUNTIME_DIR=${join(fake.root, 'runtime')}\n`)
      expect(environment).not.toMatch(/shell-admin-fixture|shell-cloud-fixture|BUCKLE_/)
    }
  })

  it('reads the installed unit back, enabled as is-enabled says, and starts, stops, restarts, and removes it', async () => {
    const fake = fakeSystemd({ enabled: false })
    const systemd = manager(fake)
    expect(await systemd.installed()).toBeNull()
    await systemd.install({ ...DEFINITION, stateDirectory: join(fake.root, 'state') }, { now: false })
    expect(await systemd.installed()).toEqual({ node: DEFINITION.node, main: DEFINITION.main, thisNode: true, enabled: false })
    await systemd.start()
    await systemd.stop!()
    await systemd.restart!()
    await systemd.uninstall()
    expect(existsSync(join(fake.root, 'config', 'systemd', 'user', 'buckle.service'))).toBe(false)
    expect(fake.calls()).toEqual(['--user daemon-reload', '--user enable buckle.service', '--user is-enabled buckle.service', '--user start buckle.service', '--user stop buckle.service',
      '--user restart buckle.service', '--user stop buckle.service', '--user disable buckle.service', '--user daemon-reload', '--user reset-failed buckle.service'])
  })

  it('says no systemd user session answers without XDG_RUNTIME_DIR, without systemctl, or when the manager does not answer', async () => {
    const fake = fakeSystemd()
    expect(await manager(fake).unavailable()).toBeNull()
    expect(fake.calls()).toEqual(['--user show --property=Version'])
    const { XDG_RUNTIME_DIR: _unset, ...noSession } = fake.environment
    expect(await manager(fake, noSession).unavailable()).toBe('No systemd user session answers here (XDG_RUNTIME_DIR is not set)')
    expect(await manager(fake, { ...fake.environment, PATH: '/nonexistent' }).unavailable()).toBe('No systemd user session answers here (systemctl is not on PATH)')
    expect(await manager(fakeSystemd({ show: 1 })).unavailable()).toBe('No systemd user session answers here (systemctl --user did not answer)')
  })

  it('says whether the user manager starts before login, and the system\'s command that would make it, which it never runs', async () => {
    const fake = fakeSystemd()
    const linger = join(fake.root, 'linger')
    mkdirSync(linger)
    const systemd = createSystemdManager({ environment: { ...fake.environment, USER: 'owner' }, run: runProcess, location: { stateDirectory: join(fake.root, 'state'), environmentFile: null }, home: fake.root, lingerDirectory: linger })
    expect(await systemd.beforeLogin!()).toEqual({ starts: false, command: 'loginctl enable-linger owner' })
    writeFileSync(join(linger, 'owner'), '')
    expect(await systemd.beforeLogin!()).toEqual({ starts: true, command: 'loginctl enable-linger owner' })
    expect(fake.calls()).toEqual([])
  })

  it('refuses where systemctl fails, naming the command and where to look, and no path', async () => {
    const fake = fakeSystemd({ fail: 'enable' })
    await expect(manager(fake).install({ ...DEFINITION, stateDirectory: join(fake.root, 'state') }, { now: false })).rejects.toThrow(new ServiceManagerError('systemctl --user enable buckle.service failed (exit code 1); systemctl --user status buckle.service and journalctl --user -u buckle.service say why'))
  })
})

describe.skipIf(process.platform === 'win32')('buckle service on Linux, with systemctl imitated', () => {
  function node(fake: FakeSystemd): { state: string; main: string } {
    const state = join(fake.root, 'state')
    mkdirSync(state, { mode: 0o700 })
    writeFileSync(join(state, 'buckle.env'), 'BUCKLE_ADMIN_TOKEN=file-admin-fixture\n', { mode: 0o600 })
    const main = join(fake.root, 'dist', 'main.js')
    mkdirSync(join(fake.root, 'dist'))
    writeFileSync(main, '')
    return { state, main }
  }

  async function run(fake: FakeSystemd, main: string, argv: string[]) {
    let out = ''
    let err = ''
    const result = await serviceCommand({ argv, environment: fake.environment, platform: 'linux', cwd: fake.root, run: runProcess, mainScript: main, manager: location => createSystemdManager({ environment: fake.environment, run: runProcess, location, home: fake.root, cwd: fake.root }), out: text => { out += text }, err: text => { err += text } })
    return { ...result, out, err }
  }

  it('installs the unit for this node and refuses a second node\'s, naming neither state directory', async () => {
    const fake = fakeSystemd()
    const { state, main } = node(fake)
    expect(await run(fake, main, ['install'])).toMatchObject({ exitCode: 0, out: 'Installed the Buckle service (the systemd user unit buckle.service); it starts at every login. Start it now with buckle service start.\n', err: '' })
    expect(readUnit(readFileSync(join(fake.root, 'config', 'systemd', 'user', 'buckle.service'), 'utf8'))).toEqual({ node: process.execPath, main, stateDirectory: state, skipsOwnerOnlyCheck: false })
    const other = { ...fake, environment: { ...fake.environment, BUCKLE_STATE_DIR: join(fake.root, 'other-state') } }
    mkdirSync(join(fake.root, 'other-state'), { mode: 0o700 })
    writeFileSync(join(fake.root, 'other-state', 'buckle.env'), '')
    const refused = await run(other, main, ['install'])
    expect(refused).toMatchObject({ exitCode: 1, err: 'A Buckle service for another state directory is installed, and this machine runs one service. Remove it with buckle service uninstall, then install this node\'s.\n' })
    expect(refused.err).not.toContain(fake.root)
  })

  // Fix brief 7, item 1: a node that fails at every start holds the serve lock only while it runs, and the unit starts it
  // again five seconds after each failure, so stop acts on the unit installed for this node whether a node holds the lock or not.
  it('stops this node\'s unit when no node runs, as between the restarts of a node that fails at every start, and not another node\'s', async () => {
    const fake = fakeSystemd()
    const { main } = node(fake)
    await run(fake, main, ['install'])
    expect(await run(fake, main, ['stop'])).toMatchObject({ exitCode: 0, out: 'Stopped the Buckle service (the systemd user unit buckle.service); no node was running.\n', err: '' })
    const stops = () => fake.calls().filter(call => call.startsWith('--user stop'))
    expect(stops()).toEqual(['--user stop buckle.service'])
    const other = { ...fake, environment: { ...fake.environment, BUCKLE_STATE_DIR: join(fake.root, 'other-state') } }
    mkdirSync(join(fake.root, 'other-state'), { mode: 0o700 })
    expect(await run(other, main, ['stop'])).toMatchObject({ exitCode: 0, out: 'Buckle is not running.\n', err: '' })
    expect(stops()).toEqual(['--user stop buckle.service'])
  })

  it('refuses where no systemd user session answers, pointing at buckle serve --background', async () => {
    const fake = fakeSystemd({ show: 1 })
    const { main } = node(fake)
    expect(await run(fake, main, ['install', '--now'])).toMatchObject({ exitCode: 1, err: 'No systemd user session answers here (systemctl --user did not answer), so nothing was installed; buckle serve --background runs the node until it stops.\n' })
  })
})
