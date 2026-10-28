import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ApprovalRequest } from '@5straps/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchApprovals } from '../cli/approvals-watch.js'
import { setupCli } from '../cli/setup.js'
import { createTerminalConsumer } from '../cli/terminal-consumer.js'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { describeAsk } from '../common/domain/approval-instruction.js'
import { approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, questionFor } from '../common/services/approvals/approval-service.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The delete policy brief, item 3: the serve terminal shows both choices for a delete outside the workspace's folder,
// the entry alone and its folder with its subfolders, each for the session or always, and `buckle approve` gains
// --below, which grants the wider subject.

const FOLDER = '/srv/data/reports'
const CALL = { arguments: { paths: [`${FOLDER}/old.csv`] }, cwd: '/workspace', description: `Delete 1 file: "${FOLDER}/old.csv"`, effects: [`delete ${FOLDER}/old.csv`], complete: true as const }

beforeEach(() => { vi.stubEnv('TERM', 'xterm-256color') })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

function deleteAsk(change: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { token: 't1', rule: 'write_scope', subject: `delete:${FOLDER}`, widerSubject: `delete-below:${FOLDER}`, reason: 'Deleting /data/reports/old.csv asks a person, whatever the folder\'s write grant says', tool: 'fs_delete', offeredScopes: ['once', 'session', 'always'], expiresAt: new Date(Date.now() + 600_000).toISOString(), ...change }
}

function silentTerminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  return { input, output, shown: () => shown }
}

const named = (ask: ApprovalRequest, withCall = true) => questionFor({ approval: ask, workspaceId: 'w-1', workspaceName: 'site', node: 'node-1', context: { correlationId: 'c', sessionId: 's', ...(withCall ? { call: CALL } : {}) } })

describe('the serve terminal\'s question about a delete outside the workspace\'s folder', () => {
  async function shown(ask: ApprovalRequest, withCall = true): Promise<string> {
    const terminal = silentTerminal()
    const stop = new AbortController()
    const asked = createTerminalConsumer({ ...terminal, onInterrupt: () => {} }).prompt(named(ask, withCall), { signal: stop.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    stop.abort()
    await asked
    return terminal.shown()
  }

  it('names the wider subject under the subject, and numbers its two choices after the scopes', async () => {
    const screen = await shown(deleteAsk())
    expect(screen).toContain(`[site]   subject: delete:${FOLDER}\n[site]   or:      delete-below:${FOLDER} (every delete in that folder and its subfolders, for the session or always)\n`)
    expect(screen).toContain('\n[site] (1) approve once  (2) approve this session  (3) always approve  (4) approve this session, folder and below  (5) always approve, folder and below  (n) deny\n')
  })

  it('offers no wider choice where the ask has none, nor for an ask recorded before this build', async () => {
    const { widerSubject: _none, ...narrow } = deleteAsk()
    expect(await shown(narrow)).toContain('\n[site] (1) approve once  (2) approve this session  (3) always approve  (n) deny\n')
    expect(await shown(deleteAsk(), false)).toContain('\n[site] (n) deny\n')
  })

  it.each([['4', 'session_below'], ['5', 'always_below'], ['2', 'session'], ['6', 'deny']])('reads %j as %s', async (typed, choice) => {
    const terminal = silentTerminal()
    const asked = setupCli({ terminal }).requestCli(named(deleteAsk()))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    terminal.input.write(`${typed}\n`)
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice } })
  })

  it('is described alike for every route that decides', () => {
    expect(describeAsk({ ...deleteAsk(), call: CALL })).toContain(`  or:      delete-below:${FOLDER} (every delete in that folder and its subfolders, for the session or always)`)
    const { widerSubject: _none, ...narrow } = deleteAsk()
    expect(describeAsk({ ...narrow, call: CALL }).join('\n')).not.toContain('  or:')
  })
})

function node(): BuckleConfig {
  return configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-below-cli-')), BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-below-cli-state-')), BUCKLE_ALLOW_SHELL: 'false' })
}

const grants = (config: BuckleConfig) => createFileGrantStore({ filePath: grantsPath(config), workspace: config.workspaceId })
const registry = (config: BuckleConfig) => createApprovalRegistry(grants(config), approvalsPath(config), config.cwd)

/** A delete outside the workspace's folder waiting on the node, with or without its wider subject. */
async function waiting(config: BuckleConfig, wider = true): Promise<string> {
  const ask = { kind: 'ask' as const, rule: 'write_scope' as const, subject: `delete:${FOLDER}`, reason: 'Deleting /data/reports/old.csv asks a person', offeredScopes: ['once' as const, 'session' as const, 'always' as const], ...(wider ? { widerSubject: `delete-below:${FOLDER}` } : {}) }
  const [request] = (await registry(config).ask({ tool: 'fs_delete', sessionId: 'chat-1', call: CALL, asks: [ask] })).requests
  return request!.token
}

async function approve(config: BuckleConfig, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; prompt: string }> {
  let stdout = ''
  let stderr = ''
  let prompt = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true })
  try {
    const result = await runCli({ argv: ['approve', ...argv], config, confirm: async (asked) => { prompt = asked; return true } })
    return { exitCode: result.exitCode, stdout, stderr, prompt }
  } finally { vi.restoreAllMocks() }
}

describe('buckle approve --below', () => {
  it('grants the folder and its subfolders for the session or always, after the person confirms that reach', async () => {
    const config = node()
    const token = await waiting(config)
    const approved = await approve(config, [token, '--scope', 'always', '--below'])
    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain(`  or:      delete-below:${FOLDER}`)
    expect(approved.prompt).toContain(`Approve ${token} (always) for every delete in ${FOLDER} and its subfolders in workspace ${basename(config.cwd)}?`)
    expect(approved.stdout).toContain(`Approved ${token} (always) for delete-below:${FOLDER}, every delete in that folder and its subfolders, in workspace ${basename(config.cwd)}`)
    expect(grants(config).list()).toMatchObject([{ rule: 'write_scope', subject: `delete-below:${FOLDER}`, scope: 'always' }])
  })

  it('grants the ask\'s own subject without it, as before', async () => {
    const config = node()
    const token = await waiting(config)
    expect((await approve(config, [token, '--scope', 'session'])).exitCode).toBe(0)
    expect(grants(config).list()).toMatchObject([{ subject: `delete:${FOLDER}`, scope: 'session' }])
  })

  it.each<[string, string[], boolean, string]>([
    ['a once approval', ['--scope', 'once', '--below'], true, 'A once approval covers the one call that asked; grant the folder and its subfolders with --scope session or --scope always'],
    ['a denial', ['--deny', '--below'], true, '--below widens an approval; deny without it'],
    ['a host pattern beside it', ['--scope', 'session', '--below', '--host', '*.example.com'], true, '--below and --host do not combine'],
    ['an ask with no wider subject', ['--scope', 'session', '--below'], false, 'offers no folder and subfolders to grant'],
  ])('refuses %s, granting nothing and leaving the ask waiting', async (_, flags, wider, refusal) => {
    const config = node()
    const token = await waiting(config, wider)
    const refused = await approve(config, [token, ...flags])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(refusal)
    expect(grants(config).list()).toEqual([])
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('refuses a token nothing waits under, naming it', async () => {
    const refused = await approve(node(), ['no-such-token', '--scope', 'session', '--below'])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('nothing named no-such-token is waiting for a decision, so --below has no folder to grant')
  })
})

describe('buckle approvals --watch', () => {
  it('offers the folder and its subfolders beside the scopes, and grants it for the session with sb', async () => {
    const config = node()
    const token = await waiting(config)
    const approvals = createApprovalService({ registry: registry(config), workspaceId: 'default', serverId: 'test-node', graceMs: config.approvalTimeoutMs, interaction: async () => undefined })
    const input = new PassThrough()
    const output = new PassThrough()
    Object.assign(output, { isTTY: true, columns: 200, rows: 24 })
    let screen = ''
    output.on('data', (chunk: Buffer) => { screen += chunk.toString('utf8') })
    const actions = createFileActionLog(join(mkdtempSync(join(tmpdir(), 'buckle-below-watch-log-')), 'actions.jsonl'))
    const done = watchApprovals({ sources: async () => [{ approvals, actions, workspaceId: 'default' }], input, output, errors: new PassThrough(), pollMs: { first: 20, idle: 50 } })
    await vi.waitFor(() => expect(screen).toMatch(/n\) skip > /), { timeout: 3_000 })
    expect(screen).toContain('o) once  s) session  always) always  sb) session, folder and below  always-below) always, folder and below  d) deny  n) skip > ')
    input.write('sb\r')
    await vi.waitFor(() => expect(screen).toContain(`Approved (session) ${token} for delete-below:${FOLDER} in workspace default`))
    input.write('\x03')
    await done
    expect(grants(config).list()).toMatchObject([{ subject: `delete-below:${FOLDER}`, scope: 'session' }])
  })
})
