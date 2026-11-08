import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchApprovals } from '../cli/approvals-watch.js'
import type { ChooseSave } from '../cli/terminal-consumer.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import type { SaveAnswer, Unsaved } from '../common/adapters/approval/grant-save-question.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { runCli } from './support/cli.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The owner's ruling on a grant that fails to save: buckle approve and buckle approvals --watch warn of it and offer a
// retry and a skip; buckle approve without a terminal prints the warning and both commands, and exits 5.

// The renames onto `rename` to fail: the first `skip` pass, then `count` fail.
const failing = vi.hoisted(() => ({ rename: undefined as string | undefined, skip: 0, count: 1 }))
vi.mock('../common/adapters/replace-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return {
    ...actual,
    replaceFile: async (from: string, to: string, io?: Parameters<typeof actual.replaceFile>[2]) => {
      if (failing.rename === to && failing.skip > 0) failing.skip -= 1
      else if (failing.rename === to && failing.count > 0) {
        failing.count -= 1
        throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' })
      }
      return actual.replaceFile(from, to, io)
    },
  }
})

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  Object.assign(failing, { rename: undefined, skip: 0, count: 1 })
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

async function open(): Promise<{ config: BuckleConfig; runtime: CoreRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-save-routes-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  return { config, runtime }
}

const write = (runtime: CoreRuntime, path: string): Promise<InvokeResponse> =>
  runtime.invoke({ request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] }, sessionId: 's' })

async function asked(runtime: CoreRuntime, path = 'one/a.md'): Promise<string> {
  const response = await write(runtime, path)
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  return response.approvals[0]!.token
}

/** An ask about a credential file, the one rule a denial may outlast its call for. */
async function askedSensitive(runtime: CoreRuntime): Promise<string> {
  const [request] = (await runtime.approvals.ask({
    tool: 'fs_read', sessionId: 's', call: { arguments: { path: '.env' }, cwd: '/workspace', description: null, effects: ['read .env'], complete: true },
    asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'sensitive_path', subject: '/workspace/.env', reason: 'a credential file', offeredScopes: ['once', 'session', 'always'] }],
  })).requests
  return request!.token
}

interface Ledger { pending: Array<{ request: { token: string } }>; resolved: Array<{ decision: { token: string; approved: boolean; scope: string }; grant?: { save: string } }> }
const ledgerOf = (config: BuckleConfig) => JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as Ledger
const saveOf = (config: BuckleConfig, token: string) => ledgerOf(config).resolved.find(entry => entry.decision.token === token)?.grant?.save
const waits = (config: BuckleConfig, token: string) => ledgerOf(config).pending.some(entry => entry.request.token === token)

function captured() {
  const output = { stdout: '', stderr: '' }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.stdout += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.stderr += String(chunk); return true })
  return output
}

/** A person at the terminal answering each save question in turn, recording what each warned of. */
function answering(answers: Array<SaveAnswer | undefined>): { chooseSave: ChooseSave; warned: Unsaved[] } {
  const warned: Unsaved[] = []
  return { warned, chooseSave: async (unsaved) => { warned.push(unsaved); return answers.shift() } }
}

describe('buckle approve, when the grant it decides cannot be saved', () => {
  it('without a terminal, prints a lasting denial\'s warning and both commands, exits 5, and records nothing', async () => {
    const { config, runtime } = await open()
    const token = await askedSensitive(runtime)
    failing.rename = grantsPath(config)
    const output = captured()
    const result = await runCli({ argv: ['approve', token, '--deny', '--scope', 'session'], config, confirm: null, chooseSave: null })
    vi.restoreAllMocks()

    expect(result.exitCode).toBe(5)
    expect(output.stderr).toContain('Not denied for the session: saving failed: permission denied; the call still waits.')
    expect(output.stderr).toContain(`buckle approve ${token} --deny --scope session --workspace`)
    expect(output.stderr).toContain(`To deny this call once instead: buckle approve ${token} --deny --workspace`)
    // What the person reads, apart from the node's own JSON log lines, names no path.
    expect(`${output.stdout}${output.stderr}`.split('\n').filter(line => !line.startsWith('{')).join('\n')).not.toContain(grantsPath(config))
    expect(waits(config, token)).toBe(true)
    expect(runtime.grants.list()).toEqual([])

    expect((await runCli({ argv: ['approve', token, '--deny', '--scope', 'session'], config, confirm: null, chooseSave: null })).exitCode).toBe(0)
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ denied: true, scope: 'session' })])
  })

  it('without a terminal, exits 5 on a repeat of an approval whose grant still cannot be saved, and keeps exit 3 for an ask', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    failing.rename = grantsPath(config)
    expect((await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: async () => true, chooseSave: answering([undefined]).chooseSave })).exitCode).toBe(5)
    expect(saveOf(config, token)).toBe('owed')

    // The opening's settling pass fails first, then the repeat's.
    Object.assign(failing, { rename: grantsPath(config), count: 2 })
    const output = captured()
    const repeated = await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: null, chooseSave: null })
    vi.restoreAllMocks()
    expect(repeated.exitCode).toBe(5)
    expect(output.stderr).toContain('Approved for this call; saving it for the session failed: permission denied.')
    expect(output.stderr).toContain('Retry with the same command; to skip, run it at a terminal and answer s.')
    expect((await runCli({ argv: ['call', 'fs_write', '--json', JSON.stringify({ path: 'one/b.md', content: 'b' })], config, confirm: null, chooseSave: null })).exitCode).toBe(3)
  })

  it('at a terminal, retries on r until the grant saves, and exits 0', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    Object.assign(failing, { rename: grantsPath(config), count: 2 })
    const person = answering(['retry', 'retry'])
    const output = captured()
    const result = await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: async () => true, chooseSave: person.chooseSave })
    vi.restoreAllMocks()

    expect(result.exitCode).toBe(0)
    expect(person.warned).toEqual([
      { kind: 'approval', warning: 'Approved for this call; saving it for the session failed: permission denied' },
      { kind: 'approval', warning: 'Approved for this call; saving it for the session failed: permission denied' },
    ])
    expect(output.stdout).toContain('Saved.')
    expect(saveOf(config, token)).toBe('saved')
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session' })])
  })

  it('at a terminal, does not say saved, and exits 5, when the session ended while its save question was open', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    failing.rename = grantsPath(config)
    const chooseSave: ChooseSave = async () => { await runtime.approvalService.endSessions({ ending: { sessionId: 's' }, cause: 'idle' }); return 'retry' }
    const output = captured()
    const result = await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: async () => true, chooseSave })
    vi.restoreAllMocks()

    expect(result.exitCode).toBe(5)
    expect(output.stdout).not.toContain('Saved.')
    expect(output.stdout).toContain('Not saved: its grant was revoked, its session ended, or a lasting denial took its place; later calls ask again.')
    expect(saveOf(config, token)).toBe('dropped')
    expect(runtime.grants.list()).toEqual([])
  })

  it('at a terminal, skips on s, records the skip, and the next call asks again', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    failing.rename = grantsPath(config)
    const output = captured()
    const result = await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: async () => true, chooseSave: answering(['skip']).chooseSave })
    vi.restoreAllMocks()

    expect(result.exitCode).toBe(0)
    expect(output.stdout).toContain('Skipped: later calls ask again.')
    expect(saveOf(config, token)).toBe('skipped')
    expect((await write(runtime, 'one/b.md')).outcome).toBe('approval_required')
    const skips = (await auditEntries(runtime.actions, 50)).filter(entry => entry.tool === 'approval_decision' && (entry.args as { outcome?: string }).outcome === 'skip_save')
    expect(skips.map(entry => [entry.event, entry.outcome])).toEqual([['attempt', 'started'], ['result', 'ok']])
    expect(skips[0]?.args).toMatchObject({ token, source: { kind: 'cli' } })
  })

  it('at a terminal, leaves the grant owed when no answer comes, exiting 5, and denies once in place of a lasting denial on s', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    failing.rename = grantsPath(config)
    const output = captured()
    expect((await runCli({ argv: ['approve', token, '--scope', 'always'], config, confirm: async () => true, chooseSave: answering([undefined]).chooseSave })).exitCode).toBe(5)
    expect(output.stdout).toContain('Left unsaved: it is written at the next decision')
    expect(saveOf(config, token)).toBe('owed')

    const denied = await askedSensitive(runtime)
    // The opening's settling pass fails first, then the denial's write.
    Object.assign(failing, { rename: grantsPath(config), count: 2 })
    const person = answering(['skip'])
    expect((await runCli({ argv: ['approve', denied, '--deny', '--scope', 'session'], config, confirm: null, chooseSave: person.chooseSave })).exitCode).toBe(0)
    vi.restoreAllMocks()
    expect(person.warned.map(unsaved => unsaved.kind)).toEqual(['denial'])
    expect(output.stdout).toContain('Denied this call once; nothing was saved.')
    expect(ledgerOf(config).resolved.find(entry => entry.decision.token === denied)?.decision).toMatchObject({ approved: false, scope: 'once' })
  })
})

describe('buckle approve, on a skip whose grant is not confirmed removed', () => {
  it('without a terminal, says the next decision or the opening removes it, that the same command retries now, and exits 5', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    const decision = { source: 'cli' as const, decision: { token, outcome: 'approve' as const, scope: 'session' as const } }
    failing.rename = grantsPath(config)
    expect(await runtime.approvalApi.decide(decision)).toMatchObject({ save: 'owed' })
    expect(await runtime.approvalApi.decide(decision)).toMatchObject({ save: 'saved' })
    Object.assign(failing, { rename: grantsPath(config), count: 1 })
    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toMatchObject({ status: 'unfinished', stands: true })

    // The opening's own write of the grants file goes through; its settling pass fails to remove the grant, then the repeat's.
    Object.assign(failing, { rename: grantsPath(config), skip: 1, count: 2 })
    const output = captured()
    const result = await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: null, chooseSave: null })
    vi.restoreAllMocks()
    expect(result.exitCode).toBe(5)
    expect(output.stderr).toContain('Skipped, but its grant, if it saved, could not be confirmed removed: permission denied.')
    expect(output.stderr).toContain('The next decision or the workspace opening again removes it; the same command sent again retries now.')
    expect(saveOf(config, token)).toBe('skipping')
  })
})

describe('the core approval API, when a skip cannot remove the grant that had saved', () => {
  it('answers the skip unfinished, naming no path, and the same skip again removes the grant', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    const decision = { source: 'cli' as const, decision: { token, outcome: 'approve' as const, scope: 'session' as const } }
    failing.rename = grantsPath(config)
    expect(await runtime.approvalApi.decide(decision)).toMatchObject({ status: 'applied', save: 'owed' })
    expect(await runtime.approvalApi.decide(decision)).toMatchObject({ status: 'repeated', save: 'saved' })

    Object.assign(failing, { rename: grantsPath(config), count: 1 })
    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toEqual({ status: 'unfinished', stands: true, saveError: 'permission denied' })
    expect(runtime.grants.list()).toHaveLength(1)
    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toEqual({ status: 'repeated', removed: true })
    expect(runtime.grants.list()).toEqual([])
  })
})

/** A terminal readline treats as a keyboard. */
function keyboardTerminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  const errors = new PassThrough()
  Object.assign(output, { isTTY: true, columns: 200, rows: 24 })
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  return { input, output, errors, shown: () => shown, type: (keys: string) => input.write(keys) }
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0

describe('buckle approvals --watch, when the grant it decides cannot be saved', () => {
  async function watching(runtime: CoreRuntime) {
    const terminal = keyboardTerminal()
    const done = watchApprovals({ sources: async () => [{ approvals: runtime.approvalService, workspaceId: runtime.workspaceId }], input: terminal.input, output: terminal.output, errors: terminal.errors, pollMs: { first: 20, idle: 50 } })
    await vi.waitFor(() => expect(count(terminal.shown(), /n\) skip > /g)).toBe(1), { timeout: 3_000 })
    return { terminal, done }
  }
  const saveAsked = (terminal: ReturnType<typeof keyboardTerminal>, times = 1) => vi.waitFor(() => expect(count(terminal.shown(), / to be saved later > /g)).toBe(times), { timeout: 3_000 })

  it('warns, asks again after a retry that fails, and saves on the next r', async () => {
    const { config, runtime } = await open()
    const token = await asked(runtime)
    Object.assign(failing, { rename: grantsPath(config), count: 2 })
    const { terminal, done } = await watching(runtime)
    try {
      terminal.type('s\r')
      await saveAsked(terminal)
      expect(terminal.shown()).toContain(`Approved (session) ${token}`)
      expect(terminal.shown()).toContain('  Approved for this call; saving it for the session failed: permission denied.\n')
      terminal.type('r\r')
      await saveAsked(terminal, 2)
      terminal.type('r\r')
      await vi.waitFor(() => expect(terminal.shown()).toContain('  Saved.\n'), { timeout: 3_000 })
      expect(saveOf(config, token)).toBe('saved')
    } finally {
      terminal.type('\x03')
      await done
    }
  })

  it('skips on s, so the next call asks again, and leaves the grant owed on Enter', async () => {
    const { config, runtime } = await open()
    const skipped = await asked(runtime)
    const left = await asked(runtime, 'two.md')
    failing.rename = grantsPath(config)
    const { terminal, done } = await watching(runtime)
    try {
      terminal.type('s\r')
      await saveAsked(terminal)
      terminal.type('s\r')
      await vi.waitFor(() => expect(terminal.shown()).toContain('  Skipped: later calls ask again.\n'), { timeout: 3_000 })
      expect(saveOf(config, skipped)).toBe('skipped')
      await vi.waitFor(() => expect(count(terminal.shown(), /n\) skip > /g)).toBe(2), { timeout: 3_000 })
      Object.assign(failing, { rename: grantsPath(config), count: 1 })
      terminal.type('s\r')
      await saveAsked(terminal, 2)
      terminal.type('\r')
      await vi.waitFor(() => expect(terminal.shown()).toContain('  Left unsaved: it is written at the next decision'), { timeout: 3_000 })
      expect(saveOf(config, left)).toBe('owed')
    } finally {
      terminal.type('\x03')
      await done
    }
  })

  it('asks a lasting denial left unsaved again, since its call still waits', async () => {
    const { config, runtime } = await open()
    const token = await askedSensitive(runtime)
    failing.rename = grantsPath(config)
    const { terminal, done } = await watching(runtime)
    try {
      terminal.type('ds\r')
      await vi.waitFor(() => expect(count(terminal.shown(), / leaves the call waiting > /g)).toBe(1), { timeout: 3_000 })
      terminal.type('\r')
      await vi.waitFor(() => expect(terminal.shown()).toContain('  Left unsaved: nothing was denied.\n'), { timeout: 3_000 })
      await vi.waitFor(() => expect(count(terminal.shown(), /n\) skip > /g)).toBe(2), { timeout: 3_000 })
      expect(count(terminal.shown(), new RegExp(`token: ${token}`, 'g'))).toBe(2)
      expect(waits(config, token)).toBe(true)
    } finally {
      terminal.type('\x03')
      await done
    }
  })

  it('denies a sensitive file once in place of a lasting denial that did not save, on s', async () => {
    const { config, runtime } = await open()
    const token = await askedSensitive(runtime)
    failing.rename = grantsPath(config)
    const { terminal, done } = await watching(runtime)
    try {
      terminal.type('ds\r')
      await vi.waitFor(() => expect(count(terminal.shown(), / leaves the call waiting > /g)).toBe(1), { timeout: 3_000 })
      expect(terminal.shown()).toContain('  Not denied for the session: saving failed: permission denied; the call still waits.\n')
      terminal.type('s\r')
      await vi.waitFor(() => expect(terminal.shown()).toContain('  Denied this call once; nothing was saved.\n'), { timeout: 3_000 })
      expect(ledgerOf(config).resolved.find(entry => entry.decision.token === token)?.decision).toMatchObject({ approved: false, scope: 'once' })
      expect(runtime.grants.list()).toEqual([])
    } finally {
      terminal.type('\x03')
      await done
    }
  })
})
