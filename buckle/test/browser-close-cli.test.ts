import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { browserCloseCommand } from '../cli/browser.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// Slice F4, item 6: the owner's `buckle browser close [--workspace <name>]` ends every browser a workspace's agents
// left, in any Buckle process, and every hold their fills left, with or without a node running.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-browser-close-cli-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  // A close fails while root/fail-close exists, as a daemon that does not answer leaves it.
  const failClose = join(root, 'fail-close')
  writeFileSync(binary, `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nif (process.argv[2] === 'close' && fs.existsSync(${JSON.stringify(failClose)})) process.exit(1)\nprocess.stdout.write('{"success":true,"data":{}}')\n`)
  chmodSync(binary, 0o755)
  const environment = { BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_AGENT_BROWSER_COMMAND: binary }
  const config = configFromEnvironment(environment)
  // The same node with other settings in force, as the owner's change to them leaves it.
  const configWith = (changed: Record<string, string>) => configFromEnvironment({ ...environment, ...changed })
  // The running node: its runtime stays open, its browsers recorded.
  const running = await createRuntime({ config })
  runtimes.push(running)
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  const sessions = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd), 'sessions.json')
  return { config, configWith, running, calls, sessions, workspace, failClose }
}

async function owner(input: { config: ReturnType<typeof configFromEnvironment>; argv: string[]; cwd?: string; ignoreWarning?: boolean }) {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  try {
    const { exitCode } = await runCli({ argv: input.argv, config: input.config, confirm: null, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.ignoreWarning === undefined ? {} : { ignoreWarning: input.ignoreWarning }) })
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
    expect(await auditEntries(running.actions, 10)).toContainEqual(expect.objectContaining({ tool: 'cli_browser_close', outcome: 'ok', detail: 'closed 2 of 2 browsers, dropped 0 held secret values' }))
    // The node's next call starts a browser of its own, as its record is gone.
    expect(await running.invoke({ sessionId: 'chat-1', request: { requestId: 'after', tool: 'browser_command', args: { command: 'snapshot', args: [] }, approvalTokens: [] } })).toMatchObject({ outcome: 'ok' })
    expect(opened).not.toContain(sessionOf(calls().at(-1)!))
  })

  it('closes through the owner audit with a target before close and the warning override enabled', async () => {
    const { config, running, calls, sessions } = await node()
    expect(await running.invoke({ sessionId: 'chat-1', request: { requestId: 'open', tool: 'browser_command', args: { command: 'open', args: ['https://example.test/'] }, approvalTokens: [] } })).toMatchObject({ outcome: 'ok' })
    const opened = sessionOf(calls()[0]!)
    const closed = await owner({ config, argv: ['browser', '--workspace', running.workspaceName(), 'close'], ignoreWarning: true })
    expect(closed).toMatchObject({ exitCode: 0, out: `Closed 1 of 1 browser of workspace ${running.workspaceName()}, and dropped 0 held secret values.\n` })
    expect(calls().slice(1).map(call => [call[0], sessionOf(call)])).toEqual([['close', opened]])
    expect(JSON.parse(readFileSync(sessions, 'utf8')).browsers).toEqual({})
    expect(await auditEntries(running.actions, 10)).toContainEqual(expect.objectContaining({ tool: 'cli_browser_close', outcome: 'ok', detail: 'closed 1 of 1 browsers, dropped 0 held secret values' }))
  })

  // Codex review L1: a browser that did not close stays recorded, and the command says it did not finish.
  it('keeps a browser whose close failed, says so, and exits 1, and the next run ends it', async () => {
    const { config, running, sessions, failClose } = await node()
    expect(await running.invoke({ sessionId: 'chat-1', request: { requestId: 'open', tool: 'browser_command', args: { command: 'open', args: ['https://example.test/'] }, approvalTokens: [] } })).toMatchObject({ outcome: 'ok' })
    writeFileSync(failClose, '')
    const name = running.workspaceName()
    const failed = await owner({ config, argv: ['browser', 'close', '--workspace', name] })
    expect(failed).toMatchObject({ exitCode: 1, out: `Closed 0 of 1 browser of workspace ${name}, and dropped 0 held secret values. 1 did not close: it stays recorded with what it holds, and the next start or this command tries again.\n` })
    expect(Object.values(JSON.parse(readFileSync(sessions, 'utf8')).browsers)).toEqual([expect.objectContaining({ closing: true })])
    // The next command's own start ends it first, as it ends any close that failed.
    rmSync(failClose)
    expect(await owner({ config, argv: ['browser', 'close', '--workspace', name] })).toMatchObject({ exitCode: 0, out: `No browser of workspace ${name} was recorded open, so nothing was closed.\n` })
    expect(JSON.parse(readFileSync(sessions, 'utf8')).browsers).toEqual({})
  })

  // Codex review L2: a close only disconnects from an attached Chrome, so its hold stays until that Chrome is closed.
  it('says an attached Chrome\'s hold stays until the command finds that Chrome closed, and exits 1', async () => {
    const runtime = { closeBrowsers: async () => ({ browsers: 0, closed: 0, held: 0, kept: 1, chromes: 1 }), workspaceName: () => 'site' } as unknown as CoreRuntime
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    expect((await browserCloseCommand(runtime, ['close'])).exitCode).toBe(1)
    expect(out).toBe('No browser of workspace site was recorded open; dropped 0 held secret values. 1 held secret value stays. An attached Chrome keeps its pages through a close, so what it was filled with stays held until this command, run while the workspace attaches to that Chrome, finds it closed: close every window of it, then run this command again.\n')
  })

  // Codex review L7: a workspace whose packs.enabled leaves the browser out now still has the browsers it recorded.
  it('ends the browsers a workspace recorded once its packs.enabled leaves the browser pack out', async () => {
    const { configWith, running, calls, sessions } = await node()
    expect(await running.invoke({ sessionId: 'chat-1', request: { requestId: 'open', tool: 'browser_command', args: { command: 'open', args: ['https://example.test/'] }, approvalTokens: [] } })).toMatchObject({ outcome: 'ok' })
    const opened = sessionOf(calls()[0]!)
    const name = running.workspaceName()
    expect(await owner({ config: configWith({ BUCKLE_PACKS: 'fs' }), argv: ['browser', 'close', '--workspace', name] })).toMatchObject({ exitCode: 0, out: `Closed 1 of 1 browser of workspace ${name}, and dropped 0 held secret values.\n` })
    expect(calls().slice(1).map(call => [call[0], sessionOf(call)])).toEqual([['close', opened]])
    expect(JSON.parse(readFileSync(sessions, 'utf8')).browsers).toEqual({})
  })

  // Codex review L3: a browser a call still runs on is left to that call, which closes it when it ends.
  it('says a browser a call still runs on closes when that call ends, and exits 1', async () => {
    const runtime = { closeBrowsers: async () => ({ browsers: 2, closed: 1, held: 0, kept: 1, busy: 1 }), workspaceName: () => 'site' } as unknown as CoreRuntime
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    expect((await browserCloseCommand(runtime, ['close'])).exitCode).toBe(1)
    expect(out).toBe('Closed 1 of 2 browsers of workspace site, and dropped 0 held secret values. 1 held secret value stays. 1 was running a call: it closes when the last call on it ends, and holds what it held until then.\n')
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
