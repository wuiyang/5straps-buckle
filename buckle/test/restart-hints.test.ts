import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it, vi } from 'vitest'
import { settingsCommand } from '../cli/settings.js'
import { serviceInstalled } from '../common/services/node-service/installed.js'
import { taskDefinitionCopy } from '../common/services/node-service/serve-record.js'

// Phase 3, item 7 of the workspace-model slice: every line that says to restart Buckle names `buckle service restart`
// where a service runs this node, and keeps its wording otherwise. Whether one does is read from disk: on Linux the
// unit naming this state directory, on Windows the task's copy in it.

function node(): { root: string; state: string; config: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-restart-hints-')))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  return { root, state, config: join(root, 'config') }
}

function unitFor(config: string, stateDirectory: string): void {
  mkdirSync(join(config, 'systemd', 'user'), { recursive: true })
  writeFileSync(join(config, 'systemd', 'user', 'buckle.service'), `[Service]\nExecStart="/usr/bin/node" "/opt/buckle/dist/main.js" serve --service systemd --state-dir "${stateDirectory}"\n`)
}

describe('whether a service runs this node', () => {
  it('is the Linux unit naming this state directory, and no other', () => {
    const { root, state, config } = node()
    const environment = { XDG_CONFIG_HOME: config }
    expect(serviceInstalled(state, environment, 'linux', root)).toBe(false)
    unitFor(config, join(root, 'other-state'))
    expect(serviceInstalled(state, environment, 'linux', root)).toBe(false)
    unitFor(config, state)
    expect(serviceInstalled(state, environment, 'linux', root)).toBe(true)
    expect(serviceInstalled(state, environment, 'darwin', root)).toBe(false)
  })

  it('is the Windows task\'s copy in the state directory', () => {
    const { root, state } = node()
    expect(serviceInstalled(state, {}, 'win32', root)).toBe(false)
    mkdirSync(join(state, 'service'))
    writeFileSync(taskDefinitionCopy(state), '')
    expect(serviceInstalled(state, {}, 'win32', root)).toBe(true)
  })
})

describe.skipIf(process.platform !== 'linux')('buckle settings, beside a service', () => {
  async function settings(argv: string[], target: ReturnType<typeof node>) {
    const file = join(target.state, 'buckle.env')
    writeFileSync(file, 'BUCKLE_PORT=4320\n', { mode: 0o600 })
    let out = ''
    let err = ''
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
    try {
      const result = await settingsCommand({ argv, environment: { BUCKLE_STATE_DIR: target.state, XDG_CONFIG_HOME: target.config }, environmentFile: file, cwd: target.root, home: target.root })
      return { ...result, out, err }
    } finally { stdout.mockRestore(); stderr.mockRestore() }
  }

  it('names buckle service restart in the usage, show, and set where a service runs this node, and buckle serve otherwise', async () => {
    const plain = node()
    expect((await settings(['set', 'allowed-hosts', 'db.internal'], plain)).out).toContain('Restart buckle serve for the change to take effect.\n')
    expect((await settings(['show'], plain)).out).toContain('A change takes effect when buckle serve restarts.\n')

    const served = node()
    unitFor(served.config, served.state)
    expect((await settings(['set', 'allowed-hosts', 'db.internal'], served)).out).toContain('Restart the node for the change to take effect: buckle service restart.\n')
    expect((await settings(['show'], served)).out).toContain('A change takes effect when the node restarts: buckle service restart.\n')
    expect((await settings(['bogus'], served)).err).toContain('A change takes effect when the node restarts: buckle service restart.\n')
  })
})
