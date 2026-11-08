import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInitCommand, runSettingsCommand } from '../cli/main.js'
import { serviceCommand, SERVICE_USAGE } from '../cli/service.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { runCli } from './support/cli.js'
import { auditWritten } from './support/action-log-writer.js'

// Asking a command for its usage has no side effect: no audit entry, as `cp --help`, `--version`, and `--help` already
// write none. `buckle init --help` once wrote a cli_init attempt and result as if init had run (the 0.1.8 publish test, B2),
// and the owner's other audited commands did the same.

let base: string
let state: string
let printed: { out: string; err: string }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'buckle-help-audit-'))
  state = join(base, 'state')
  printed = { out: '', err: '' }
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed.out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { printed.err += String(chunk); return true })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }) })

/**
 * Every line of every audit log under the state directory, the node's and each workspace's, once the log service has
 * written what the owner's commands queued: init, settings, and service hand theirs over and return without closing it.
 */
async function auditLines(directory: string): Promise<string[]> {
  await auditWritten()
  return linesUnder(directory)
}

function linesUnder(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return linesUnder(path)
    return /^actions\.jsonl(\.\d+)?$/.test(name) ? readFileSync(path, 'utf8').split('\n').filter(line => line !== '') : []
  })
}

function node() {
  return configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(base, 'workspace-')), BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false' })
}

const OWNER_COMMANDS = ['approve', 'approvals', 'check-url', 'grants', 'workspaces', 'history', 'plugin', 'policy', 'workspace', 'keys']

describe('a help request writes no audit entry', () => {
  it('is seen by the audit helper when a command does run, so the other tests cannot pass for want of looking', async () => {
    const config = node()
    expect((await runCli({ argv: ['grants'], config })).exitCode).toBe(0)
    expect((await auditLines(state)).map(line => JSON.parse(line)).map(entry => [entry.tool, entry.event])).toEqual([['cli_grants', 'attempt'], ['cli_grants', 'result']])
  })

  it.each(OWNER_COMMANDS.flatMap(command => [[command, '--help'], [command, '-h']]))('buckle %s %s prints its usage, exits 0, and audits nothing', async (command, flag) => {
    const config = node()
    const result = await runCli({ argv: [command!, flag!], config })
    expect(result.exitCode).toBe(0)
    expect(printed.out).toContain(`buckle ${command}`)
    expect(await auditLines(state)).toEqual([])
  })

  it.each([
    [['approvals', 'show', '--help']],
    [['approve', 'some-token', '--help']],
    [['history', 'restore', '--help']],
    [['policy', 'allow-command', '--help']],
  ])('buckle %j audits nothing', async (argv) => {
    const result = await runCli({ argv, config: node() })
    expect(result.exitCode).toBe(0)
    expect(await auditLines(state)).toEqual([])
  })

  it('asks for help from a folder no workspace holds, and still writes nothing', async () => {
    const result = await runCli({ argv: ['approve', '--help'], config: node(), cwd: tmpdir() })
    expect(result.exitCode).toBe(0)
    expect(await auditLines(state)).toEqual([])
  })

  it.each(['--help', '-h'])('buckle init %s prints the usage and writes no audit entry, though the config it reads names a state directory', async (flag) => {
    vi.stubEnv('BUCKLE_STATE_DIR', state)
    const result = await runInitCommand([flag])
    expect(result.exitCode).toBe(0)
    expect(printed.out).toContain('Usage: buckle init')
    expect(await auditLines(state)).toEqual([])
  })

  it.each(['--help', '-h'])('buckle settings %s prints the usage, exits 0, and audits nothing', async (flag) => {
    vi.stubEnv('BUCKLE_STATE_DIR', state)
    const result = await runSettingsCommand([flag])
    expect(result.exitCode).toBe(0)
    expect(printed.out).toContain('buckle settings show')
    expect(await auditLines(state)).toEqual([])
  })

  it('still audits a settings command that runs', async () => {
    vi.stubEnv('BUCKLE_STATE_DIR', state)
    expect((await runSettingsCommand(['show'])).exitCode).toBe(0)
    expect(await auditLines(state)).toHaveLength(2)
  })

  it.each([
    [['install', '--help']],
    [['install', '--now', '-h']],
    [['uninstall', '--help']],
    [['start', '-h']],
    [['stop', '--help']],
    [['restart', '-h']],
  ])('buckle service %j prints the usage, exits 0, and audits nothing, though the state folder exists', async (rest) => {
    mkdirSync(state, { mode: 0o700 })
    const result = await serviceCommand({ argv: rest, environment: { HOME: base, PATH: '/usr/bin:/bin', BUCKLE_STATE_DIR: state }, platform: 'linux', cwd: base, run: vi.fn(), mainScript: join(base, 'main.js'), manager: () => null })
    expect(result.exitCode).toBe(0)
    expect(printed.out).toBe(SERVICE_USAGE)
    expect(printed.err).toBe('')
    expect(await auditLines(state)).toEqual([])
  })
})
