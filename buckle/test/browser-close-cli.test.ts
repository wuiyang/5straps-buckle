import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Slice F4, item 6: the owner's `buckle browser close [--workspace <name>]` ends every browser a workspace's agents
// left, in any Buckle process, and every hold their fills left, with or without a node running.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-browser-close-cli-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdout.write('{"success":true,"data":{}}')\n`)
  chmodSync(binary, 0o755)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_AGENT_BROWSER_COMMAND: binary })
  // The running node: its runtime stays open, its browsers recorded.
  const running = await createRuntime({ config })
  runtimes.push(running)
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  const sessions = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd), 'sessions.json')
  return { config, running, calls, sessions, workspace }
}

async function owner(input: { config: ReturnType<typeof configFromEnvironment>; argv: string[]; cwd?: string }) {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  try {
    const { exitCode } = await runCli({ argv: input.argv, config: input.config, confirm: null, ...(input.cwd ? { cwd: input.cwd } : {}) })
    return { exitCode, out, err }
  } finally { vi.restoreAllMocks() }
}

const sessionOf = (call: string[]) => call[call.indexOf('--session') + 1]

describe('buckle browser close', () => {
  it('closes every browser the workspace recorded, a running node\'s included, and prints the counts', async () => {
    const { config, running, calls, sessions } = await node()
    for (const sessionId of ['chat-1', 'chat-2']) {
      expect(await running.invoke({ sessionId, request: { requestId: `open-${sessionId}`, tool: 'browser_command', args: { command: 'open', args: ['https://example.test/'] }, approvalTokens: [] } })).toMatchObject({ outcome: 'ok' })
    }
    const opened = calls().map(sessionOf)
    const closed = await owner({ config, argv: ['browser', 'close', '--workspace', running.workspaceName()] })
    expect(closed).toMatchObject({ exitCode: 0, out: `Closed 2 of 2 browsers of workspace ${running.workspaceName()}, and dropped 0 held secret values.\n` })
    expect(calls().slice(2).map(call => call.slice(0, 3))).toEqual([['close', '--json', '--config'], ['close', '--json', '--config']])
    expect(calls().slice(2).map(sessionOf).sort()).toEqual([...opened].sort())
    expect(JSON.parse(readFileSync(sessions, 'utf8')).browsers).toEqual({})
    expect(running.actions.read(10)).toContainEqual(expect.objectContaining({ tool: 'cli_browser_close', outcome: 'ok', detail: 'closed 2 of 2 browsers, dropped 0 held secret values' }))
    // The node's next call starts a browser of its own, as its record is gone.
    expect(await running.invoke({ sessionId: 'chat-1', request: { requestId: 'after', tool: 'browser_command', args: { command: 'snapshot', args: [] }, approvalTokens: [] } })).toMatchObject({ outcome: 'ok' })
    expect(opened).not.toContain(sessionOf(calls().at(-1)!))
  })

  it('acts on the workspace holding the current directory, and says so where nothing was open', async () => {
    const { config, running, calls, workspace } = await node()
    expect(await owner({ config, argv: ['browser', 'close'], cwd: workspace })).toMatchObject({ exitCode: 0, out: `No browser of workspace ${running.workspaceName()} was recorded open, so nothing was closed.\n` })
    expect(calls()).toEqual([])
  })

  it('prints its usage for --help, and refuses words it does not take', async () => {
    const { config, workspace } = await node()
    const help = await owner({ config, argv: ['browser', 'close', '--help'] })
    expect(help.exitCode).toBe(0)
    expect(help.out).toContain('Usage: buckle browser close [--workspace <name>]')
    const refused = await owner({ config, argv: ['browser', 'close', '--all'], cwd: workspace })
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Usage: buckle browser close [--workspace <name>]')
  })
})
