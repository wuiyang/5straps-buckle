import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { readRecord, serviceLogPath } from '../../common/services/node-service/serve-record.js'
import { freePort, waitForStatus } from '../support/buckle-process.js'

// Phase 3, items 1 and 2 of the workspace-model slice: the built `buckle service` installs a systemd user unit and
// drives it through systemctl. No systemd user session runs on CI, so a systemctl on PATH plays the user manager: it
// runs the unit's ExecStart as systemd would, stops the node with SIGTERM, and records each call's words and
// environment, which must hold no credential, the shell's or buckle.env's.

const entry = inject('buckleBuild').main
const pids: number[] = []

afterAll(() => {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

function fakeUserManager(root: string, state: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const unit = join(root, 'config', 'systemd', 'user', 'buckle.service')
  const stop = `p=$(sed -n 's/.*"pid": *\\([0-9]*\\).*/\\1/p' '${state}/service/serve.json' 2>/dev/null)
    if test -n "$p"; then kill -TERM "$p"; while kill -0 "$p" 2>/dev/null; do sleep 0.1; done; fi`
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> '${root}/calls'
env >> '${root}/environments'
case "$2" in
  show) echo Version=255; exit 0 ;;
  is-enabled) test -f '${root}/enabled'; exit $? ;;
  enable) touch '${root}/enabled'; exit 0 ;;
  disable) rm -f '${root}/enabled'; exit 0 ;;
  stop) ${stop}
    exit 0 ;;
  start|restart)
    if test "$2" = restart; then ${stop}
    fi
    command=$(sed -n 's/^ExecStart=//p' '${unit}')
    eval "$command" </dev/null >/dev/null 2>&1 &
    exit 0 ;;
esac
exit 0
`)
  chmodSync(join(bin, 'systemctl'), 0o755)
  return bin
}

describe('buckle service on Linux, with the systemd user manager imitated', () => {
  it('installs and starts the unit, restarts it, stops it with SIGTERM, and removes it, passing no credential on', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-service-systemd-')))
    const state = join(root, 'state')
    mkdirSync(state, { mode: 0o700 })
    mkdirSync(join(root, 'runtime'))
    const port = await freePort()
    writeFileSync(join(state, 'buckle.env'), `BUCKLE_HOST=127.0.0.1\nBUCKLE_PORT=${port}\nBUCKLE_ADMIN_TOKEN=file-admin-fixture\n`, { mode: 0o600 })
    const bin = fakeUserManager(root, state)
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: join(root, 'runtime'), XDG_CONFIG_HOME: join(root, 'config'), BUCKLE_STATE_DIR: state, BUCKLE_ADMIN_TOKEN: 'shell-admin-fixture' }
    const buckle = (args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env, cwd: root, timeout: 60_000 })

    const installed = buckle(['service', 'install', '--now'])
    expect(installed.stderr).toBe('')
    const pid = Number(/^Installed and started the Buckle service \(the systemd user unit buckle\.service, pid (\d+)\); it starts at every login\.\n$/.exec(installed.stdout)![1])
    pids.push(pid)
    expect(readRecord(state)).toMatchObject({ pid, manager: 'systemd', port })
    await waitForStatus(`http://127.0.0.1:${port}/health/ready`, 200)
    const unit = readFileSync(join(root, 'config', 'systemd', 'user', 'buckle.service'), 'utf8')
    expect(unit).toContain(`ExecStart="${process.execPath}" "${entry}" serve --service systemd --state-dir "${state}"\n`)
    expect(unit).not.toMatch(/admin-fixture/)

    const status = buckle(['service', 'status'])
    expect(status.stdout).toContain('Service    the systemd user unit buckle.service, starts at login\n')
    expect(status.stdout).toContain(`Running    yes (pid ${pid}), started by systemd at `)

    const restarted = buckle(['service', 'restart'])
    expect(restarted.stderr).toBe('')
    const second = Number(/^Restarted the Buckle service \(pid (\d+)\) at http:\/\/127\.0\.0\.1:\d+\.\n$/.exec(restarted.stdout)![1])
    pids.push(second)
    expect(second).not.toBe(pid)

    expect(buckle(['service', 'stop'])).toMatchObject({ status: 0, stdout: `Stopped Buckle (pid ${second}).\n` })
    const lines = readFileSync(serviceLogPath(state), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { message: string; fields?: { signal?: string } })
    expect(lines).toContainEqual(expect.objectContaining({ message: 'Shutdown requested', fields: { signal: 'SIGTERM' } }))
    expect(buckle(['service', 'uninstall'])).toMatchObject({ status: 0, stdout: 'Removed the Buckle service (the systemd user unit buckle.service); the state directory is kept.\n' })
    expect(existsSync(join(root, 'config', 'systemd', 'user', 'buckle.service'))).toBe(false)

    expect(readFileSync(join(root, 'calls'), 'utf8').split('\n').filter(Boolean)).toEqual([
      '--user show --property=Version', '--user daemon-reload', '--user enable buckle.service', '--user restart buckle.service',
      '--user is-enabled buckle.service', '--user is-enabled buckle.service', '--user restart buckle.service',
      '--user stop buckle.service', '--user is-enabled buckle.service', '--user stop buckle.service', '--user disable buckle.service', '--user daemon-reload', '--user reset-failed buckle.service',
    ])
    const environments = readFileSync(join(root, 'environments'), 'utf8')
    expect(environments).not.toMatch(/admin-fixture|BUCKLE_/)
  }, 120_000)
})
