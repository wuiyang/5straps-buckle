import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CLIENT_CAPABILITIES_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type ApprovalWait, type InvokeResponse, type JsonObject, type JsonValue, type ToolCapability } from '@5straps/protocol'
import { StateBusyError } from '../common/adapters/json-file-store.js'
import { createPiCodemodeVm } from '../common/adapters/script-vm/pi-codemode.js'
import { NestedApprovalRequired, ToolExecutionError, type NestedCall, type ToolContext } from '../common/domain/tool.js'
import { loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { CODE_CALL_LIMIT, CODE_GLOBAL_LIMIT, CODE_REPLAY_DIVERGED, createCodePack, MAX_GLOBAL_CALLS, MAX_NESTED_CALLS } from '../common/services/packs/code/index.js'
import { CODE_REPLAY_TOO_LARGE, createJournalStore, JOURNAL_BYTES, JOURNAL_TTL_MS, scriptOfAsk, TEMPORARY_GRACE_MS, type Journal } from '../common/services/packs/code/journal.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ScriptVm, ScriptVmResult } from '../common/types/ports/script-vm.js'
import { runCli } from '../cli/main.js'
import { createMcpServer } from '../mcp/server.js'
import { isExplicitCancel } from '../mcp/stdio.js'
import { fixedInteraction } from './support/interaction.js'

// An ask inside a script (owner decision D82, points 6 and 7): the script stops, the outer call answers with the
// nested call's own ask, shown whole (owner decision D17), and the same script sent again replays what already ran.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const READ_THEN_WRITE = 'const read = await tools.fs_read({ path: "notes.md" }); await tools.fs_write({ path: "one/out.md", content: read.content.toUpperCase() }); text("written"); return Math.random()'

function setup(environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-code-asks-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  for (const directory of ['workspace', 'workspace/one', 'workspace/two']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(workspace, 'notes.md'), 'hello')
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code', ...environment })
  return { root, workspace, config }
}

async function node(environment: Record<string, string> = {}) {
  const fixture = setup(environment)
  return { ...fixture, runtime: await open(fixture.config) }
}

function open(config: BuckleConfig): Promise<BuckleRuntime> {
  return createRuntime({ config, interaction: fixedInteraction() })
}

let sequence = 0
function run(runtime: BuckleRuntime, script: string, stageId = 'stage-a'): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId: `outer-${++sequence}`, tool: 'code_run', args: { script }, approvalTokens: [], context: { stageId } } })
}

/** code_run as HTTP sends it, with no wait hint and no cancel test, or as stdio does, with its cancel test. */
function send(runtime: BuckleRuntime, script: string, input: { timeoutMs?: number; approvalWait?: ApprovalWait; isCancel?: (reason: unknown) => boolean; signal?: AbortSignal } = {}): Promise<InvokeResponse> {
  return runtime.invoke({
    sessionId: 'chat-1', ...(input.approvalWait ? { approvalWait: input.approvalWait } : {}), ...(input.isCancel ? { isCancel: input.isCancel } : {}), ...(input.signal ? { signal: input.signal } : {}),
    request: { requestId: `outer-${++sequence}`, tool: 'code_run', args: { script, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }, approvalTokens: [], context: { stageId: 'stage-a' } },
  })
}

function results(runtime: BuckleRuntime, tool: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.tool === tool)
}

/** fs_read made slow for one path, for `wait` ms or until it settles, its tool ignoring its signal as a slow tool may; every run is counted by path. */
function slowRead(runtime: BuckleRuntime, slowPath: string, wait: number | Promise<void>): string[] {
  const runs: string[] = []
  const fsRead = runtime.registry().get('fs_read')
  const prepare = fsRead.prepare.bind(fsRead)
  vi.spyOn(fsRead, 'prepare').mockImplementation((args) => {
    const prepared = prepare(args)
    return { ...prepared, execute: async (context: ToolContext) => {
      runs.push(String(args.path))
      if (args.path === slowPath) await (typeof wait === 'number' ? new Promise(resolve => setTimeout(resolve, wait)) : wait)
      return await prepared.execute(context)
    } }
  })
  return runs
}

/** Every run of a tool's own code, by its path argument: what actually ran, whatever the audit log says was answered. */
function countRuns(runtime: BuckleRuntime, tool: string): Map<string, number> {
  const runs = new Map<string, number>()
  const registered = runtime.registry().get(tool)
  const prepare = registered.prepare.bind(registered)
  vi.spyOn(registered, 'prepare').mockImplementation((args) => {
    const prepared = prepare(args)
    return { ...prepared, execute: async (context: ToolContext) => {
      runs.set(String(args.path), (runs.get(String(args.path)) ?? 0) + 1)
      return await prepared.execute(context)
    } }
  })
  return runs
}

async function answer(runtime: BuckleRuntime, token: string, approved = true) {
  expect((await runtime.approvalService.answer({ decision: { token, approved, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
}

function journals(root: string): string[] {
  const directory = join(root, 'state', 'code-journal')
  return existsSync(directory) ? readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.json')).map(name => join(directory, name)) : []
}

function attempts(runtime: BuckleRuntime, tool: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'attempt' && entry.tool === tool)
}

function asked(response: InvokeResponse) {
  if (response.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${JSON.stringify(response)}`)
  return response.approvals
}

describe('a call inside a script that needs a person', () => {
  it('stops the script: the outer call answers approval_required with the nested call\'s ask, recorded whole, and keeps a journal', async () => {
    const { root, workspace, runtime } = await node()
    const [approval, ...others] = asked(await run(runtime, READ_THEN_WRITE))

    expect(others).toEqual([])
    expect(approval).toMatchObject({ tool: 'fs_write', rule: 'write_scope', subject: join(workspace, 'one') })
    const [waiting] = runtime.approvalService.waiting()
    expect(waiting?.call).toMatchObject({
      complete: true, cwd: workspace, arguments: { path: 'one/out.md', content: 'HELLO' },
      description: `Called by a "code_run" script, request "outer-${sequence}"; buckle approvals show <token> prints the script: Write 5 bytes to "one/out.md" in "${workspace}"`,
      effects: [`write ${join(workspace, 'one', 'out.md')}`],
    })
    expect(existsSync(join(workspace, 'one', 'out.md'))).toBe(false)
    const outer = runtime.actions.read(50).filter(entry => entry.event === 'result' && entry.tool === 'code_run')
    expect(outer).toEqual([expect.objectContaining({ outcome: 'approval_required', asked: ['write_scope'] })])
    const [file] = journals(root)
    expect(statSync(file!).mode & 0o777).toBe(0o600)
    expect(statSync(join(file!, '..')).mode & 0o777).toBe(0o700)
    expect((JSON.parse(readFileSync(file!, 'utf8')) as Journal).entries.map(entry => [entry.seq, entry.id, entry.tool])).toEqual([[1, 1, 'fs_read']])
    await runtime.history.close()
  })

  it('replays the calls that ran when the same script is sent again after the answer, and runs the one that asked', async () => {
    const { root, workspace, runtime } = await node()
    const [approval] = asked(await run(runtime, READ_THEN_WRITE))
    const first = `outer-${sequence}`
    await answer(runtime, approval!.token)
    const read = vi.spyOn(runtime.registry().get('fs_read'), 'prepare')

    const retried = await run(runtime, READ_THEN_WRITE, 'stage-b')
    expect(retried).toMatchObject({ outcome: 'ok', output: { ok: true, output: 'written' } })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(read).not.toHaveBeenCalled()
    expect(attempts(runtime, 'fs_read')).toHaveLength(1)
    // One parent for the script, its first run's code_run call, before and after its ask (finding docs-rules
    // code-mode.md:111), and each send's own stage, as its direct calls have (final review of 0.1.4, finding invoker 701).
    expect(attempts(runtime, 'fs_write').map(entry => [entry.stageId, entry.parentRequestId])).toEqual([['stage-a', first], ['stage-b', first]])
    expect(journals(root)).toEqual([])

    // Done by itself, the script is a new run when sent again: its calls run again, and the spent once asks again.
    expect(asked(await run(runtime, READ_THEN_WRITE))).toHaveLength(1)
    expect(attempts(runtime, 'fs_read')).toHaveLength(2)
    await runtime.history.close()
  })

  it('shows the nested ask whole in an MCP host\'s form, and runs once the host retries with the answer', async () => {
    const { workspace, runtime } = await node()
    const server = createMcpServer({ runtime, serverName: 'buckle-test', serverId: 'node-7', version: '0.0.0', trustedApprovalResponses: true, followToolChanges: false })
    const call = (responses?: Record<string, unknown>) => {
      const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<unknown> }> })._registeredTools
      const envelope = { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } }
      return tools['code_run']!.handler({ script: READ_THEN_WRITE }, { sessionId: 'mcp-1', mcpReq: { id: 1, method: 'tools/call', requestState: () => undefined, envelope, ...(responses ? { inputResponses: responses } : {}) } } as unknown as ServerContext)
    }

    const first = await call() as { resultType: string; inputRequests: Record<string, { params: { message: string } }> }
    expect(first.resultType).toBe('input_required')
    const forms = Object.entries(first.inputRequests)
    expect(forms).toHaveLength(1)
    const [token, form] = forms[0]!
    expect(form.params.message).toContain('fs_write needs approval')
    expect(form.params.message).toContain('does:     Called by a "code_run" script, request')
    expect(form.params.message).toContain('"content": "HELLO"')

    const second = await call({ [token]: { action: 'accept', content: { approve: true, scope: 'once' } } }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(second.isError).not.toBe(true)
    expect(JSON.parse(second.content[0]!.text)).toMatchObject({ ok: true, output: 'written' })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(attempts(runtime, 'fs_read')).toHaveLength(1)
    // MCP gives each tools/call its own requestId, which a script's calls name as their parent; the retry keeps the
    // first one. They carry no stage, as the direct calls of the same host carry none.
    const nested = [...attempts(runtime, 'fs_read'), ...attempts(runtime, 'fs_write')]
    const parents = [...new Set(nested.map(entry => entry.parentRequestId))]
    expect(parents).toHaveLength(1)
    expect(nested.map(entry => entry.stageId)).toEqual([undefined, undefined, undefined])
    // With no stage or run named, the change history files the script's write under its parent, the first code_run call.
    expect((await runtime.history.list()).map(checkpoint => [checkpoint.tool, checkpoint.stageId])).toEqual([['fs_write', parents[0]]])
    await runtime.history.close()
  })

  it('hands back the asks of calls made at once together, and runs both once both are answered', async () => {
    const { workspace, runtime } = await node()
    const script = 'await Promise.all([tools.fs_write({ path: "one/a.md", content: "a" }), tools.fs_write({ path: "two/b.md", content: "b" })]); return "both"'
    const approvals = asked(await run(runtime, script))

    expect(approvals.map(approval => approval.subject).sort()).toEqual([join(workspace, 'one'), join(workspace, 'two')])
    for (const approval of approvals) await answer(runtime, approval.token)
    expect(await run(runtime, script)).toMatchObject({ outcome: 'ok', output: { value: 'both' } })
    expect([readFileSync(join(workspace, 'one', 'a.md'), 'utf8'), readFileSync(join(workspace, 'two', 'b.md'), 'utf8')]).toEqual(['a', 'b'])
    await runtime.history.close()
  })

  // Re-check of round 2, finding journal-turn index.ts:326: a turn that asks more than the session's 50 pending asks
  // allows gets APPROVAL_LIMIT for the rest, which is retryable and never journaled, so once the person has answered,
  // the retries make those calls, and no write runs twice.
  it('makes again on the retry a call the session\'s ask cap refused in the turn that asked, and writes nothing twice', async () => {
    const { root, workspace, runtime } = await node()
    for (let index = 0; index < 60; index++) mkdirSync(join(workspace, `d${index}`))
    const writes = countRuns(runtime, 'fs_write')
    const script = 'await Promise.all(Array.from({ length: 60 }, (_, i) => tools.fs_write({ path: "d" + i + "/a.md", content: "x" }))); return "all"'

    const first = asked(await run(runtime, script))
    expect(first).toHaveLength(50)
    const [record] = journals(root)
    expect((JSON.parse(readFileSync(record!, 'utf8')) as Journal).entries).toEqual([])
    for (const approval of first) await answer(runtime, approval.token)

    const second = asked(await run(runtime, script))
    expect(second).toHaveLength(10)
    expect(writes.size).toBe(50)
    for (const approval of second) await answer(runtime, approval.token)

    expect(await run(runtime, script)).toMatchObject({ outcome: 'ok', output: { ok: true, value: 'all' } })
    expect(writes.size).toBe(60)
    expect([...writes.values()].every(count => count === 1)).toBe(true)
    expect(journals(root)).toEqual([])
    await runtime.history.close()
  }, 60_000)

  it('hands a denial after the ask to the script as an error it can catch', async () => {
    const { workspace, runtime } = await node()
    const script = 'try { await tools.fs_write({ path: "one/out.md", content: "x" }); return "written" } catch (error) { return error.code }'
    const [approval] = asked(await run(runtime, script))
    await answer(runtime, approval!.token, false)

    expect(await run(runtime, script)).toMatchObject({ outcome: 'ok', output: { ok: true, value: 'PERMISSION_DENIED' } })
    expect(existsSync(join(workspace, 'one', 'out.md'))).toBe(false)
    await runtime.history.close()
  })
})

describe('a call inside a script that waits for a person, as the CLI and HTTP do', () => {
  // Review of the code-mode slice, findings approvals-replay 685, invoker-audit 228, and tests 46: the script's
  // deadline never cuts a wait, and Buckle's own aborts never read as the caller's cancel.
  it.each([
    ['over HTTP, which passes no cancel test', undefined],
    ['over stdio, whose cancel test reads every abort but a closed connection as a cancel', isExplicitCancel],
  ])('ends the wait before the script\'s deadline and answers approval_required, the ask still pending, %s', async (_route, isCancel) => {
    const { root, runtime } = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const [approval, ...others] = asked(await send(runtime, READ_THEN_WRITE, { timeoutMs: 2_500, ...(isCancel ? { isCancel } : {}) }))

    expect(others).toEqual([])
    expect(approval).toMatchObject({ tool: 'fs_write', rule: 'write_scope' })
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([approval!.token])
    expect(journals(root)).toHaveLength(1)
    // The cut wait is the ask the outer call reports, not a failed tool.
    expect(results(runtime, 'fs_write').map(entry => [entry.outcome, entry.detail])).toEqual([['approval_required', undefined]])
    await runtime.history.close()
  }, 30_000)

  // Re-review of the code-mode slice, finding fixes-hold invoker.ts:712: the cap is a deadline read just before the
  // wait, and a slow announce is held to it, so a slow approval webhook never turns the ask into a timeout.
  it.each([1_300, 3_000])('answers approval_required before the deadline when the approval webhook takes %i ms, the ask still pending', async (delayMs) => {
    const webhook = createServer((request, response) => { request.resume(); setTimeout(() => response.end('{}'), delayMs) })
    await new Promise<void>(resolve => webhook.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = webhook.address() as AddressInfo
      const { root, runtime } = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000', BUCKLE_APPROVAL_WEBHOOK: `http://127.0.0.1:${port}/approvals` })
      const [approval, ...others] = asked(await send(runtime, READ_THEN_WRITE, { timeoutMs: 2_500 }))
      expect(others).toEqual([])
      expect(runtime.approvalService.pending().map(request => request.token)).toEqual([approval!.token])
      expect(journals(root)).toHaveLength(1)
      expect(results(runtime, 'fs_write').map(entry => [entry.outcome, entry.detail])).toEqual([['approval_required', undefined]])
      await runtime.history.close()
    } finally {
      webhook.closeAllConnections()
      await new Promise(resolve => webhook.close(resolve))
    }
  }, 30_000)

  // Re-check of round 2, finding deadline-announce code-approvals.test.ts:221: the announce a script's call left to
  // finish in the background is still delivered before close resolves, so a process that exits after code_run
  // answers does not drop the approver's notice.
  it('waits at close for the announce a script call left running in the background', async () => {
    // Only the announce is slow; lifecycle notices, which close also waits for, are answered at once.
    const answered: number[] = []
    const webhook = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        if (!body.includes('"approvals"')) return response.end('{}')
        response.on('finish', () => answered.push(performance.now()))
        setTimeout(() => response.end('{}'), 3_000)
      })
    })
    await new Promise<void>(resolve => webhook.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = webhook.address() as AddressInfo
      const { runtime } = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000', BUCKLE_APPROVAL_WEBHOOK: `http://127.0.0.1:${port}/approvals` })
      asked(await send(runtime, READ_THEN_WRITE, { timeoutMs: 2_500 }))
      expect(answered).toEqual([])

      await runtime.approvalService.close()
      const closed = performance.now()
      expect(answered.length).toBeGreaterThan(0)
      expect(answered[0]).toBeLessThanOrEqual(closed)
      await runtime.history.close()
    } finally {
      webhook.closeAllConnections()
      await new Promise(resolve => webhook.close(resolve))
    }
  }, 30_000)

  // Re-check of round 2, finding deadline-announce invoker.ts:175: an ask the registry records only after the script's
  // deadline, behind a slow approvals lock, is still handed back as approval_required, never a timeout.
  it.each([2_600, 3_000])('answers approval_required when the approvals lock holds the ask %i ms, past a 2.5 s script', async (lockMs) => {
    const { root, runtime } = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const ask = runtime.approvals.ask.bind(runtime.approvals)
    vi.spyOn(runtime.approvals, 'ask').mockImplementation(async (input) => {
      await new Promise(resolve => setTimeout(resolve, lockMs))
      return await ask(input)
    })
    const [approval, ...others] = asked(await send(runtime, READ_THEN_WRITE, { timeoutMs: 2_500 }))
    expect(others).toEqual([])
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([approval!.token])
    expect(journals(root)).toHaveLength(1)
    expect(results(runtime, 'fs_write').map(entry => [entry.outcome, entry.detail])).toEqual([['approval_required', undefined]])
    await runtime.history.close()
  }, 30_000)

  // Re-check of round 2, finding deadline-announce invoker.ts:712: a call that first reads its signal after the
  // invoker's backstop timer fired too is still audited SCRIPT_ENDED, not logged as a failed tool.
  it('audits SCRIPT_ENDED for a call that reads its signal only after the backstop timer fired', async () => {
    const { runtime } = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const evaluate = runtime.approvals.evaluate.bind(runtime.approvals)
    vi.spyOn(runtime.approvals, 'evaluate').mockImplementation(async (input) => {
      if (input.tool === 'fs_write') await new Promise(resolve => setTimeout(resolve, 4_000))
      return await evaluate(input)
    })
    const failed = vi.spyOn(logger, 'error')
    expect(await send(runtime, READ_THEN_WRITE, { timeoutMs: 2_500 })).toMatchObject({ outcome: 'ok', output: { ok: false, error: { kind: 'timeout' } } })
    expect(results(runtime, 'fs_write').map(entry => [entry.outcome, entry.detail])).toEqual([['error', 'SCRIPT_ENDED']])
    expect(failed.mock.calls.filter(([message]) => message === 'Tool invocation failed')).toEqual([])
    failed.mockRestore()
    await runtime.history.close()
  }, 30_000)

  // Re-check of round 3, finding late-ask-audit invoker.ts:635: a call whose listener hears the invoker's backstop
  // before the pack's own cancel, as when the main thread stalls across the script's deadline, is still audited
  // SCRIPT_ENDED, not logged as a failed tool.
  it('audits SCRIPT_ENDED when the backstop timer reaches a waiting call before the pack\'s cancel', async () => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, 'slow.md'), 'slow')
    const fsRead = runtime.registry().get('fs_read')
    const prepare = fsRead.prepare.bind(fsRead)
    vi.spyOn(fsRead, 'prepare').mockImplementation(args => ({ ...prepare(args), execute: (context: ToolContext) => new Promise<JsonValue>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    }) }))
    const failed = vi.spyOn(logger, 'error')
    // The main thread stalls from just before the script's deadline to past its backstop's, so both come due together.
    const stall = setTimeout(() => { const until = performance.now() + 1_300; while (performance.now() < until) { /* stalled */ } }, 2_400)
    try {
      expect(await send(runtime, 'return await tools.fs_read({ path: "slow.md" })', { timeoutMs: 2_500 })).toMatchObject({ outcome: 'ok', output: { ok: false, error: { kind: 'timeout' } } })
    } finally {
      clearTimeout(stall)
    }
    expect(results(runtime, 'fs_read').map(entry => [entry.outcome, entry.detail])).toEqual([['error', 'SCRIPT_ENDED']])
    expect(failed.mock.calls.filter(([message]) => message === 'Tool invocation failed')).toEqual([])
    failed.mockRestore()
    await runtime.history.close()
  }, 30_000)

  it('leaves the ask pending over stdio when Buckle shuts down during the wait, and withdraws it on the client\'s own cancel', async () => {
    const waiting = { timeoutMs: 20_000, approvalWait: { mode: 'finite' as const, ms: 10_000 }, isCancel: isExplicitCancel }
    const stopped = await node()
    const cut = send(stopped.runtime, READ_THEN_WRITE, waiting)
    await vi.waitFor(() => expect(stopped.runtime.approvalService.waiting()).toHaveLength(1), { timeout: 10_000 })
    await stopped.runtime.cancelInvocations()
    await cut
    expect(stopped.runtime.approvalService.pending()).toHaveLength(1)
    await stopped.runtime.history.close()

    const cancelled = await node()
    const caller = new AbortController()
    const left = send(cancelled.runtime, READ_THEN_WRITE, { ...waiting, signal: caller.signal })
    await vi.waitFor(() => expect(cancelled.runtime.approvalService.waiting()).toHaveLength(1), { timeout: 10_000 })
    caller.abort(new Error('notifications/cancelled'))
    await left.catch(() => undefined)
    await vi.waitFor(() => expect(cancelled.runtime.approvalService.pending()).toEqual([]))
    await cancelled.runtime.history.close()
  }, 30_000)

  // Re-review of the code-mode slice, finding new-surface index.ts:338: an ask already collected is withdrawn by the
  // caller's own cancel too, not only one still inside its wait.
  it.each([
    ['withdraws it over stdio, where the client cancelled', isExplicitCancel, 0],
    ['leaves it pending over HTTP, where a dropped connection is no cancel', undefined, 1],
  ])('when the caller leaves after the script collected an ask, %s', async (_how, isCancel, pending) => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, 'slow.md'), 'slow')
    slowRead(runtime, 'slow.md', 2_000)
    const caller = new AbortController()
    const script = 'await Promise.all([tools.fs_write({ path: "one/a.md", content: "a" }), tools.fs_read({ path: "slow.md" })])'
    const left = send(runtime, script, { timeoutMs: 20_000, approvalWait: { mode: 'finite', ms: 200 }, signal: caller.signal, ...(isCancel ? { isCancel } : {}) })
    await vi.waitFor(() => expect(results(runtime, 'fs_write').map(entry => entry.outcome)).toEqual(['approval_required']), { timeout: 10_000 })
    caller.abort(new Error('notifications/cancelled'))
    await left.catch(() => undefined)

    expect(runtime.approvalService.pending()).toHaveLength(pending)
    await runtime.history.close()
  }, 30_000)

  // Re-review of the code-mode slice, finding tests invoker.ts:748: a call the script's end cut while it waited is
  // audited SCRIPT_ENDED, not logged as a failed tool, and its ask stays pending.
  it.each([
    ['over HTTP', undefined],
    ['over stdio', isExplicitCancel],
  ])('audits a call the script\'s end cut as SCRIPT_ENDED and leaves its ask pending, %s', async (_route, isCancel) => {
    const { workspace, runtime } = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    writeFileSync(join(workspace, 'gate.md'), 'gate')
    let release!: () => void
    slowRead(runtime, 'gate.md', new Promise<void>((resolve) => { release = resolve }))
    const failed = vi.spyOn(logger, 'error')
    const script = 'tools.fs_write({ path: "one/out.md", content: "x" }).catch(() => {}); await tools.fs_read({ path: "gate.md" }); return 1'
    const running = send(runtime, script, { timeoutMs: 20_000, approvalWait: { mode: 'finite', ms: 10_000 }, ...(isCancel ? { isCancel } : {}) })
    await vi.waitFor(() => expect(runtime.approvalService.waiting()).toHaveLength(1), { timeout: 10_000 })
    release()

    expect(await running).toMatchObject({ outcome: 'ok', output: { ok: true, value: 1 } })
    expect(results(runtime, 'fs_write').map(entry => [entry.outcome, entry.detail])).toEqual([['error', 'SCRIPT_ENDED']])
    expect(runtime.approvalService.pending()).toHaveLength(1)
    expect(failed.mock.calls.filter(([message]) => message === 'Tool invocation failed')).toEqual([])
    failed.mockRestore()
    await runtime.history.close()
  }, 30_000)

  it('lets the script go on once the person answers while its call waits inside it', async () => {
    const { root, workspace, runtime } = await node()
    const running = send(runtime, READ_THEN_WRITE, { timeoutMs: 20_000, approvalWait: { mode: 'finite', ms: 10_000 } })
    await vi.waitFor(() => expect(runtime.approvalService.waiting()).toHaveLength(1), { timeout: 10_000 })
    await answer(runtime, runtime.approvalService.waiting()[0]!.request.token)

    expect(await running).toMatchObject({ outcome: 'ok', output: { ok: true, output: 'written' } })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(attempts(runtime, 'fs_read')).toHaveLength(1)
    expect(journals(root)).toEqual([])
    await runtime.history.close()
  }, 30_000)

  it('hands back the ask when a short wait ends inside a longer script, and the re-sent script replays what ran', async () => {
    const { root, workspace, runtime } = await node()
    const wait = { timeoutMs: 20_000, approvalWait: { mode: 'finite' as const, ms: 200 } }
    const [approval] = asked(await send(runtime, READ_THEN_WRITE, wait))
    expect(journals(root)).toHaveLength(1)
    await answer(runtime, approval!.token)
    const read = vi.spyOn(runtime.registry().get('fs_read'), 'prepare')

    expect(await send(runtime, READ_THEN_WRITE, wait)).toMatchObject({ outcome: 'ok', output: { ok: true } })
    expect(read).not.toHaveBeenCalled()
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    await runtime.history.close()
  }, 30_000)
})

describe('buckle approvals show, for an ask a script made', () => {
  async function capture(argv: string[], config: BuckleConfig): Promise<{ exitCode: number; stdout: string }> {
    let stdout = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
    try {
      return { exitCode: (await runCli({ confirm: async () => false, argv, config })).exitCode, stdout }
    } finally { write.mockRestore() }
  }

  // Review of the code-mode slice, coordinator decision 4: the audit log keeps the script's size alone.
  it('prints the ask whole and the script that made it, kept with its record, and decides nothing', async () => {
    const { config, runtime } = await node()
    const [approval] = asked(await run(runtime, READ_THEN_WRITE))
    await runtime.history.close()

    const shown = await capture(['approvals', 'show', approval!.token], config)
    expect(shown.exitCode).toBe(0)
    expect(shown.stdout).toContain('buckle approvals show <token> prints the script')
    expect(shown.stdout).toContain('"content": "HELLO"')
    expect(shown.stdout).toContain(`The code_run script that made this call:\n${READ_THEN_WRITE}\n`)
    expect(JSON.parse((await capture(['approvals', 'show', approval!.token, '--json'], config)).stdout)).toMatchObject({ token: approval!.token, tool: 'fs_write', script: READ_THEN_WRITE, call: { arguments: { content: 'HELLO' } } })
    expect((await capture(['approvals', 'show', 'not-a-token'], config)).exitCode).toBe(1)
    expect((await capture(['approvals', 'show'], config)).exitCode).toBe(1)
    const after = await open(config)
    expect(after.approvalService.pending().map(request => request.token)).toEqual([approval!.token])
    await after.history.close()
  })

  // Re-review of the code-mode slice, finding tests main.ts:349: without the record, show says the script is not
  // kept yet, and an ask no script made gets neither line.
  it('says the script is not kept when its record is not there, and says nothing of a script for a direct call', async () => {
    const { root, config, runtime } = await node()
    const [scripted] = asked(await run(runtime, READ_THEN_WRITE))
    for (const file of journals(root)) rmSync(file)
    const [direct] = asked(await runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId: 'direct-1', tool: 'fs_write', args: { path: 'two/x.md', content: 'x' }, approvalTokens: [] } }))
    await runtime.history.close()

    const shown = await capture(['approvals', 'show', scripted!.token], config)
    expect(shown.stdout).toContain('A code_run script made this call')
    expect(shown.stdout).toContain('it is not kept yet')
    expect(shown.stdout).not.toContain('The code_run script that made this call:')
    expect(JSON.parse((await capture(['approvals', 'show', scripted!.token, '--json'], config)).stdout)).not.toHaveProperty('script')
    const plain = await capture(['approvals', 'show', direct!.token], config)
    expect(plain.exitCode).toBe(0)
    expect(plain.stdout).not.toContain('code_run script')
  })
})

describe('the replay journal', () => {
  it('survives a restart of the runtime: the calls that ran are not run again', async () => {
    const { config, workspace } = setup()
    const before = await open(config)
    const [approval] = asked(await run(before, READ_THEN_WRITE))
    await before.history.close()

    const after = await open(config)
    await answer(after, approval!.token)
    expect(await run(after, READ_THEN_WRITE)).toMatchObject({ outcome: 'ok', output: { ok: true } })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(attempts(after, 'fs_read')).toHaveLength(1)
    await after.history.close()
  })

  it('is not replayed once expired: the script runs from its start', async () => {
    const { root, runtime } = await node()
    asked(await run(runtime, READ_THEN_WRITE))
    const [file] = journals(root)
    writeFileSync(file!, JSON.stringify({ ...JSON.parse(readFileSync(file!, 'utf8')), expiresAt: Date.now() - 1 }))
    // The re-send dedupe expires with it (EXECUTION_TTL_MS): the clock stands in for the ten minutes passing, and
    // reaches the dedupe, so the read really runs again rather than being answered by its earlier record (review of
    // the code-mode slice, finding tests 181).
    const read = vi.spyOn(runtime.registry().get('fs_read'), 'prepare')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + JOURNAL_TTL_MS + 1_000)
    try {
      asked(await run(runtime, READ_THEN_WRITE))
    } finally {
      vi.restoreAllMocks()
    }
    expect(read).toHaveBeenCalledTimes(1)
    expect(results(runtime, 'fs_read').map(entry => entry.detail)).toEqual([undefined, undefined])
    await runtime.history.close()
  })

  it('expires after ten minutes, and keeps a workspace\'s journals within their bound, oldest first', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-journal-'))
    roots.push(directory)
    let now = 1_000_000
    const store = createJournalStore({ directory, now: () => now, workspaceBytes: 2_500 })
    const journal = (key: string) => ({ key, startedAt: 1, seed: 2, tools: [], entries: [{ seq: 1, now: 1, id: 1, tool: 'echo', args: 'x', outcome: { ok: true as const, value: 'v'.repeat(900) } }] })

    expect(await store.write(journal('a'.repeat(64)))).toBe(true)
    now += JOURNAL_TTL_MS - 1
    expect(store.read('a'.repeat(64))).not.toBeNull()
    now += 1
    expect(store.read('a'.repeat(64))).toBeNull()
    expect(readdirSync(directory)).toEqual([])

    for (const key of ['b', 'c', 'd']) {
      expect(await store.write(journal(key.repeat(64)))).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(readdirSync(directory).sort()).toEqual([`${'c'.repeat(64)}.json`, `${'d'.repeat(64)}.json`])
    expect(await createJournalStore({ directory, now: () => now, journalBytes: 500 }).write(journal('e'.repeat(64)))).toBe(false)
  })

  // Review of the code-mode slice, findings approvals-replay 240, invoker-audit 134, and tests 243: a script stopped
  // from outside keeps its record, so the same script sent again, after a restart too, runs none of its calls again,
  // and its clock repeats, so a call whose arguments read it is replayed rather than refused.
  it.each(['deadline', 'cancel', 'shutdown'])('keeps the record of a script stopped by its %s, so the re-sent script runs none of its calls again, after a restart too', async (stop) => {
    const { root, workspace, config } = setup()
    const spin = 'const read = await tools.fs_read({ path: "notes.md" }); await tools.fs_find_names({ path: ".", pattern: "x" + Date.now() }); text(read.content); while (true) {}'
    const first = await open(config)
    const caller = new AbortController()
    const running = send(first, spin, { timeoutMs: stop === 'deadline' ? 1_500 : 20_000, signal: caller.signal })
    await vi.waitFor(() => expect(results(first, 'fs_find_names')).toHaveLength(1), { timeout: 10_000 })
    if (stop === 'cancel') caller.abort(new Error('stopped by the caller'))
    if (stop === 'shutdown') await first.cancelInvocations()
    await running.catch(() => undefined)
    expect(journals(root)).toHaveLength(1)
    await first.history.close()

    writeFileSync(join(workspace, 'notes.md'), 'changed')
    const after = await open(config)
    const prepared = [vi.spyOn(after.registry().get('fs_read'), 'prepare'), vi.spyOn(after.registry().get('fs_find_names'), 'prepare')]
    expect(await send(after, spin, { timeoutMs: 1_500 })).toMatchObject({ outcome: 'ok', output: { ok: false, output: 'hello', error: { kind: 'timeout' } } })
    for (const spy of prepared) expect(spy).not.toHaveBeenCalled()
    await after.history.close()
  }, 30_000)

  // Review of the code-mode slice, findings invoker-audit executions.ts:7 and 134: with its record gone, a re-sent
  // script's calls that ran are answered by stubs that say to change the script, and none runs again.
  it('never runs a script\'s call twice when its record is gone, and tells the script to change', async () => {
    const { root, runtime } = await node()
    const spin = 'const codes = []; for (const call of [() => tools.fs_read({ path: "notes.md" }), () => tools.fs_find_names({ path: ".", pattern: "x" + Date.now() })]) { try { await call() } catch (error) { codes.push(error.code) } } text(codes.join()); while (true) {}'
    expect(await send(runtime, spin, { timeoutMs: 1_500 })).toMatchObject({ outcome: 'ok', output: { output: '', error: { kind: 'timeout' } } })
    for (const file of journals(root)) rmSync(file)
    const prepared = [vi.spyOn(runtime.registry().get('fs_read'), 'prepare'), vi.spyOn(runtime.registry().get('fs_find_names'), 'prepare')]

    expect(await send(runtime, spin, { timeoutMs: 1_500 })).toMatchObject({ outcome: 'ok', output: { output: 'REQUEST_ALREADY_EXECUTED,CODE_REPLAY_DIVERGED', error: { kind: 'timeout' } } })
    for (const spy of prepared) expect(spy).not.toHaveBeenCalled()
    await runtime.history.close()
  }, 30_000)

  // Re-review of the code-mode slice, findings new-surface and fixes-hold index.ts:302, docs-rules code-mode-02.md:22.
  it('journals a call a shutdown cut after it began to run, so the script re-sent after the restart never runs it again', async () => {
    const { root, workspace, config } = setup()
    writeFileSync(join(workspace, 'slow.md'), 'slow')
    const script = 'const a = await tools.fs_read({ path: "notes.md" }); const b = await tools.fs_read({ path: "slow.md" }); return [a.content, b.content]'
    const first = await open(config)
    const runs = slowRead(first, 'slow.md', 1_500)
    const running = send(first, script, { timeoutMs: 20_000 })
    await vi.waitFor(() => expect(runs).toEqual(['notes.md', 'slow.md']), { timeout: 10_000 })
    await first.cancelInvocations()
    expect(await running).toMatchObject({ outcome: 'error', error: { code: 'BUCKLE_SHUTTING_DOWN' } })
    expect(journals(root)).toHaveLength(1)
    await first.history.close()

    const after = await open(config)
    const prepared = vi.spyOn(after.registry().get('fs_read'), 'prepare')
    expect(await send(after, script, { timeoutMs: 20_000 })).toMatchObject({ outcome: 'ok', output: { ok: false, error: { kind: 'script', message: expect.stringContaining('REQUEST_ALREADY_EXECUTED') } } })
    expect(prepared).not.toHaveBeenCalled()
    expect(runs).toEqual(['notes.md', 'slow.md'])
    await after.history.close()
  }, 30_000)

  // Re-check of round 3, finding journal-turn index.ts:330: a call cut after it began to run is journaled as run even
  // when it then answers a retryable error, as an LSP request that ignores its abort does, so a restart never runs it
  // again.
  it('journals as run a call cut after it began, though it then failed retryably, so a restart never runs it again', async () => {
    const { root, workspace, config } = setup()
    writeFileSync(join(workspace, 'slow.md'), 'slow')
    const runs: string[] = []
    const slowRetryable = (runtime: BuckleRuntime, name: string) => {
      const fsRead = runtime.registry().get('fs_read')
      const prepare = fsRead.prepare.bind(fsRead)
      vi.spyOn(fsRead, 'prepare').mockImplementation((args) => ({ ...prepare(args), execute: async () => {
        runs.push(`${name}:${String(args.path)}`)
        await new Promise(resolve => setTimeout(resolve, 2_500))
        throw new ToolExecutionError('The language server did not answer in time', { code: 'LSP_TIMEOUT', retryable: true })
      } }))
    }
    const script = 'return (await Promise.allSettled([tools.fs_write({ path: "one/out.md", content: "x" }), tools.fs_read({ path: "slow.md" })])).map(item => item.status === "fulfilled" ? "ok" : item.reason.code)'
    const first = await open(config)
    slowRetryable(first, 'A')
    const [approval] = asked(await send(first, script, { timeoutMs: 1_500, approvalWait: { mode: 'none' } }))
    const [record] = journals(root)
    expect((JSON.parse(readFileSync(record!, 'utf8')) as Journal).entries.map(entry => [entry.tool, entry.outcome.ok ? 'ok' : (entry.outcome.properties as { code: string }).code])).toEqual([['fs_read', 'REQUEST_ALREADY_EXECUTED']])
    await answer(first, approval!.token)
    await first.history.close()

    const snapshot = join(root, 'state-after-restart')
    cpSync(join(root, 'state'), snapshot, { recursive: true })
    const after = await open(loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: snapshot, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code' }))
    slowRetryable(after, 'B')
    expect(await send(after, script, { timeoutMs: 20_000, approvalWait: { mode: 'none' } })).toMatchObject({ outcome: 'ok', output: { ok: true, value: ['ok', 'REQUEST_ALREADY_EXECUTED'] } })
    expect(runs).toEqual(['A:slow.md'])
    await after.history.close()
  }, 30_000)

  // Final review of 0.1.4, finding docs code-mode-02.md:19: a script stopped once its results passed 32 MiB cannot
  // resume, but its record keeps its calls as stubs that say they ran, so the same script sent again after a restart,
  // when the process remembers nothing, runs none of them again.
  it('keeps the calls of a script stopped past the record bound as stubs, so a re-send after a restart runs none again', async () => {
    const { root, workspace, config } = setup()
    writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(9 * 1_048_576))
    const script = 'for (let i = 0; i < 4; i++) await tools.fs_read({ path: "large.txt" }); await tools.fs_find_names({ path: ".", pattern: "notes" }); while (true) {}'
    const first = await open(config)
    const running = send(first, script, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(results(first, 'fs_find_names')).toHaveLength(1), { timeout: 50_000 })
    await first.cancelInvocations()
    expect(await running).toMatchObject({ outcome: 'error', error: { code: 'BUCKLE_SHUTTING_DOWN' } })
    const [file] = journals(root)
    const record = JSON.parse(readFileSync(file!, 'utf8')) as Journal
    expect(record.entries.map(entry => [entry.tool, entry.outcome.ok ? 'ok' : entry.outcome.properties?.code])).toEqual([
      ...Array.from({ length: 4 }, () => ['fs_read', 'REQUEST_ALREADY_EXECUTED']), ['fs_find_names', 'REQUEST_ALREADY_EXECUTED'],
    ])
    expect(statSync(file!).size).toBeLessThan(64 * 1_024)
    await first.history.close()

    const after = await open(config)
    const prepared = [vi.spyOn(after.registry().get('fs_read'), 'prepare'), vi.spyOn(after.registry().get('fs_find_names'), 'prepare')]
    // Recheck of the final review of 0.1.4, finding code index.ts:480: the record outlives the send that ended on its
    // stub, so every unchanged send in its ten minutes runs nothing, the third as the second.
    for (let again = 0; again < 2; again++) {
      expect(await send(after, script, { timeoutMs: 20_000 })).toMatchObject({ outcome: 'ok', output: { ok: false, error: { kind: 'script', message: expect.stringContaining('REQUEST_ALREADY_EXECUTED') } } })
      expect(journals(root)).toEqual([file])
    }
    for (const spy of prepared) expect(spy).not.toHaveBeenCalled()
    await after.history.close()
  }, 120_000)

  // Rechecks 2 and 3 of the final review of 0.1.4, findings code index.ts:363 and :368: a tool policy change between
  // a stop and the re-send. describeTool answers from the run's own tool list alone, so a tool allowed or denied since
  // is answered as the first run was, the replay runs as it did, and the write that ran never runs again.
  describe('across a tool policy change between the stop and the re-send', () => {
    const SCRIPT = 'const d = await describeTool("fs_find_names"); if (!d) await describeTool("fs_list"); await tools.fs_write({ path: "logs/deploy.md", content: "deployed" }); await tools.fs_write({ path: "one/out.md", content: "x" }); return "end"'
    const policy = (deny: string[]) => WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), tools: { deny }, filesystem: { rules: [{ path: 'logs', write: 'allow' }] } })
    const writes = (runtime: BuckleRuntime) => attempts(runtime, 'fs_write').map(entry => entry.args)

    it('replays normally when a tool describeTool asked about is allowed since, and the write runs once', async () => {
      const { workspace, runtime } = await node()
      mkdirSync(join(workspace, 'logs'))
      await runtime.policy.apply(policy(['fs_find_names']))
      const [approval] = asked(await run(runtime, SCRIPT))
      await answer(runtime, approval!.token)
      await runtime.policy.apply(policy([]))

      expect(await run(runtime, SCRIPT)).toMatchObject({ outcome: 'ok', output: { ok: true, value: 'end' } })
      expect(writes(runtime).filter(args => (args as { path: string }).path === `[${'logs/deploy.md'.length} characters]`)).toHaveLength(1)
      expect(writes(runtime)).toHaveLength(3)
      await runtime.history.close()
    })

    // The skeptic's parallel shift: the asked call's number is recorded nowhere, so a changed describeTool answer once
    // moved the recorded write onto it, ran it again, and left the send to stall until its deadline.
    it('runs the recorded write once when the calls made at once would shift onto the asked call\'s number', async () => {
      const { workspace, runtime } = await node()
      mkdirSync(join(workspace, 'logs'))
      const parallel = 'const d = await describeTool("fs_find_names"); await Promise.all([d ? null : tools.fs_write({ path: "one/out.md", content: "x" }), tools.fs_write({ path: "logs/deploy.md", content: "deployed" })]); return "end"'
      await runtime.policy.apply(policy(['fs_find_names']))
      const [approval] = asked(await run(runtime, parallel))
      await answer(runtime, approval!.token)
      await runtime.policy.apply(policy([]))

      const began = performance.now()
      expect(await run(runtime, parallel)).toMatchObject({ outcome: 'ok', output: { ok: true, value: 'end' } })
      expect(performance.now() - began).toBeLessThan(10_000)
      expect(writes(runtime).filter(args => (args as { path: string }).path === `[${'logs/deploy.md'.length} characters]`)).toHaveLength(1)
      await runtime.history.close()
    }, 30_000)

    it('replays describeTool from the run\'s own tools when a tool it declared is denied since', async () => {
      const { workspace, runtime } = await node()
      mkdirSync(join(workspace, 'logs'))
      await runtime.policy.apply(policy([]))
      const [approval] = asked(await run(runtime, SCRIPT))
      await answer(runtime, approval!.token)
      await runtime.policy.apply(policy(['fs_find_names']))

      expect(await run(runtime, SCRIPT)).toMatchObject({ outcome: 'ok', output: { ok: true, value: 'end' } })
      expect(writes(runtime)).toHaveLength(3)
      expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('x')
      await runtime.history.close()
    })
  })

  it('resumes the same script sent again with another timeoutMs: the script alone names it', async () => {
    const { workspace, runtime } = await node()
    const [approval] = asked(await send(runtime, READ_THEN_WRITE, { timeoutMs: 20_000, approvalWait: { mode: 'none' } }))
    await answer(runtime, approval!.token)
    const read = vi.spyOn(runtime.registry().get('fs_read'), 'prepare')

    expect(await send(runtime, READ_THEN_WRITE, { timeoutMs: 25_000, approvalWait: { mode: 'none' } })).toMatchObject({ outcome: 'ok', output: { ok: true } })
    expect(read).not.toHaveBeenCalled()
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    await runtime.history.close()
  })

  // Review of the code-mode slice, findings sandbox-boundary journal.ts:134 and :121.
  const record = (key: string) => ({ key, startedAt: 1, seed: 2, tools: [], entries: [{ seq: 1, now: 1, id: 1, tool: 'echo', args: 'x', outcome: { ok: true as const, value: 'tool result' } }] })

  // Review of the code-mode slice, coordinator decision 5.
  it(`withdraws the asks of a script that cannot resume, answering ${CODE_REPLAY_TOO_LARGE}`, async () => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(9 * 1_048_576))
    const script = 'let size = 0; for (let i = 0; i < 4; i++) size += (await tools.fs_read({ path: "large.txt" })).size; await tools.fs_write({ path: "one/out.md", content: String(size) })'
    expect(await run(runtime, script)).toMatchObject({ outcome: 'error', error: { code: CODE_REPLAY_TOO_LARGE } })
    expect(runtime.approvalService.pending()).toEqual([])
    expect(results(runtime, 'fs_write').map(entry => entry.outcome)).toEqual(['approval_required'])
    await runtime.history.close()
  }, 60_000)

  it('removes expired journals and a crashed write\'s leftovers when a store opens, with no further write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-prune-'))
    roots.push(directory)
    expect(() => createJournalStore({ directory: join(directory, 'never-made') })).not.toThrow()
    let now = Date.now()
    expect(await createJournalStore({ directory, now: () => now }).write(record('a'.repeat(64)))).toBe(true)
    // Its mtime pinned to the injected clock, so the expiry below does not hang on how long the write took (re-review
    // of the code-mode slice, finding tests 411).
    utimesSync(join(directory, `${'a'.repeat(64)}.json`), now / 1_000, now / 1_000)
    const leftover = join(directory, `.${'b'.repeat(64)}.${randomUUID()}.tmp`)
    const writing = join(directory, `.${'c'.repeat(64)}.${randomUUID()}.tmp`)
    for (const path of [leftover, writing]) writeFileSync(path, 'part of a tool result')
    const crashed = (Date.now() - TEMPORARY_GRACE_MS - 1_000) / 1_000
    utimesSync(leftover, crashed, crashed)

    createJournalStore({ directory, now: () => now })
    expect(readdirSync(directory).sort()).toEqual([basename(writing), `${'a'.repeat(64)}.json`].sort())
    now += JOURNAL_TTL_MS + 1
    createJournalStore({ directory, now: () => now })
    expect(readdirSync(directory)).toEqual([])
  })

  it('leaves no temporary file behind when a write fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-full-'))
    roots.push(directory)
    const store = createJournalStore({ directory })
    const real = fs.writeSync
    fs.writeSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
    syncBuiltinESMExports()
    try {
      await expect(store.write(record('d'.repeat(64)))).rejects.toThrow('no space left')
    } finally {
      fs.writeSync = real
      syncBuiltinESMExports()
    }
    expect(readdirSync(directory)).toEqual([])
  })

  // Review of the code-mode slice, finding tests 195: a journal from another VM is refused, whatever its entries.
  it('refuses to replay a journal another VM wrote, and runs nothing of it again', async () => {
    const { root, runtime } = await node()
    asked(await run(runtime, READ_THEN_WRITE))
    const [file] = journals(root)
    writeFileSync(file!, JSON.stringify({ ...JSON.parse(readFileSync(file!, 'utf8')) as Journal, vm: 'another-engine' }))
    const read = vi.spyOn(runtime.registry().get('fs_read'), 'prepare')
    expect(runtime.approvalService.pending()).toHaveLength(1)

    expect(await run(runtime, READ_THEN_WRITE)).toMatchObject({ outcome: 'error', error: { code: 'CODE_REPLAY_DIVERGED', retryable: false } })
    expect(read).not.toHaveBeenCalled()
    // Re-review of the code-mode slice, finding docs-rules code-mode.md:76: no call would spend the first run's ask.
    expect(runtime.approvalService.pending()).toEqual([])
    // Recheck 3 of the final review of 0.1.4, finding code index.ts:487: the record is kept until it expires.
    expect(journals(root)).toEqual([file])
    await runtime.history.close()
  })

  // Review of the code-mode slice, finding tests executions.ts:195: an HTTP client re-sends under its own requestId.
  it('runs the script when code_run is re-sent under the same requestId after the answer', async () => {
    const { workspace, runtime } = await node()
    const send = () => runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId: 'r1', tool: 'code_run', args: { script: READ_THEN_WRITE }, approvalTokens: [], context: { stageId: 'stage-a' } } })
    const [approval] = asked(await send())
    await answer(runtime, approval!.token)

    expect(await send()).toMatchObject({ outcome: 'ok', output: { ok: true, output: 'written' } })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(attempts(runtime, 'fs_read')).toHaveLength(1)
    expect(results(runtime, 'code_run').map(entry => entry.detail)).toEqual([undefined, undefined])
    await runtime.history.close()
  })

  it('refuses a script that, replayed, makes other calls than its first run did', async () => {
    const { root, runtime } = await node()
    asked(await run(runtime, READ_THEN_WRITE))
    const [file] = journals(root)
    const journal = JSON.parse(readFileSync(file!, 'utf8')) as Journal
    writeFileSync(file!, JSON.stringify({ ...journal, entries: journal.entries.map(entry => ({ ...entry, args: '0'.repeat(64) })) }))

    expect(await run(runtime, READ_THEN_WRITE)).toMatchObject({ outcome: 'error', error: { code: 'CODE_REPLAY_DIVERGED', retryable: false, message: expect.stringContaining('Change the script') } })
    await runtime.history.close()
  })
})

describe('the journal of a script stopped at an ask, made by the pack', () => {
  const echo: ToolCapability = { name: 'echo', description: 'Echo.', inputSchema: { type: 'object' }, risk: 'read', tags: [], pack: 'test' }
  const gate: ToolCapability = { ...echo, name: 'gate', description: 'Asks.' }
  const waiter: ToolCapability = { ...echo, name: 'waiter', description: 'Waits for a person.' }
  const ok = (call: NestedCall, output: JsonValue): InvokeResponse => ({ requestId: `code:${call.id}`, outcome: 'ok', output, meta: { durationMs: 0, truncated: false } })
  /** What the invoker answers for a call its signal cut, as the pack's teardown does. */
  const cut = (call: NestedCall): InvokeResponse => ({ requestId: `code:${call.id}`, outcome: 'error', error: { code: 'SCRIPT_ENDED', message: 'cut', retryable: false } })
  const ask = (call: NestedCall): InvokeResponse => ({ requestId: `code:${call.id}`, outcome: 'approval_required', approvals: [{ token: `token-${call.id}`, rule: 'write_scope', subject: '/w', reason: 'asks', tool: call.tool, offeredScopes: ['once'], expiresAt: new Date(Date.now() + 60_000).toISOString() }] })

  function codeRun(directory: string, invokeNested: (call: NestedCall) => Promise<InvokeResponse>, input: { timeoutMs?: number; signal?: AbortSignal; forgetNested?: (ids: readonly number[]) => void; withdrawNested?: (tokens: readonly string[]) => Promise<void>; callerCancelled?: () => boolean; journalBytes?: number; vm?: ScriptVm } = {}) {
    const pack = createCodePack({ vm: input.vm ?? createPiCodemodeVm(), reachableTools: () => [echo, gate, waiter], journalDirectory: directory, unavailableReason: null, ...(input.journalBytes ? { journalBytes: input.journalBytes } : {}) })
    const context: ToolContext = { requestId: 'outer', sessionId: 'chat-1', timeoutMs: input.timeoutMs ?? 60_000, signal: input.signal ?? new AbortController().signal, nestedKey: 'f'.repeat(64), invokeNested, forgetNested: input.forgetNested ?? (() => {}), ...(input.withdrawNested ? { withdrawNested: input.withdrawNested } : {}), ...(input.callerCancelled ? { callerCancelled: input.callerCancelled } : {}) }
    return (script: string) => pack.tools[0]!.prepare({ script }).execute(context)
  }

  function kept(directory: string): Journal[] {
    return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Journal)
  }

  function scratch(): string {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-pack-'))
    roots.push(directory)
    return directory
  }

  // Review of the code-mode slice, finding tests 243: the condition that forgets the records is pinned both ways.
  it('forgets the re-send records only of a script that ended by itself, and keeps the journal of one stopped from outside', async () => {
    const ending = async (script: string, input: { timeoutMs?: number; abortAfterCall?: boolean; vm?: ScriptVm } = {}) => {
      const directory = scratch()
      const caller = new AbortController()
      const forgetNested = vi.fn()
      const echoed = async (call: NestedCall) => {
        if (input.abortAfterCall) setTimeout(() => caller.abort(new Error('stopped by the caller')), 50)
        return ok(call, 'echoed')
      }
      const result = await codeRun(directory, echoed, { ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.vm ? { vm: input.vm } : {}), signal: caller.signal, forgetNested })(script) as { error?: { kind: string } }
      return { kind: result.error?.kind ?? 'ok', forgotten: forgetNested.mock.calls, journal: kept(directory).map(journal => journal.entries.map(entry => entry.tool)) }
    }

    expect(await ending('await tools.echo({}); return 1')).toEqual({ kind: 'ok', forgotten: [[[1]]], journal: [] })
    expect(await ending('await tools.echo({}); throw new Error("boom")')).toEqual({ kind: 'script', forgotten: [[[1]]], journal: [] })
    // A 300 ms deadline counted from the VM's readiness: a stub makes the call, and times out 300 ms after its answer.
    // pi-codemode counts its deadline from before the worker starts, which a loaded host can spend in full (re-review
    // of the code-mode slice, finding tests 512).
    const timingOut: ScriptVm = {
      declare: () => '', identifier: name => name,
      start(vmInput) {
        let answered!: () => void
        const delivered = new Promise<void>((resolve) => { answered = resolve })
        queueMicrotask(() => vmInput.onCall({ id: 1, target: 'tool', name: 'echo', args: {} }))
        const result = delivered.then(() => new Promise<ScriptVmResult>(resolve => setTimeout(() => resolve({ ok: false, output: [], outputTruncated: false, calls: [{ id: 1, name: 'echo', status: 'ok', durationMs: 0 }], error: { kind: 'timeout', message: 'The script ran past its 300 ms' } }), 300)))
        return { deliver: () => answered(), get finished() { return false }, result }
      },
    }
    expect(await ending('await tools.echo({}); while (true) {}', { vm: timingOut })).toEqual({ kind: 'timeout', forgotten: [], journal: [['echo']] })
    expect(await ending('await tools.echo({}); while (true) {}', { abortAfterCall: true })).toEqual({ kind: 'aborted', forgotten: [], journal: [['echo']] })
  })

  // Re-review of the code-mode slice, findings new-surface and tests index.ts:287: every call of the turn an ask came
  // in runs or asks, however the threads are scheduled; the invoker here asks at once, the race the loaded suite lost.
  it.each([
    ['made at once', 'await Promise.all([tools.gate({ n: 1 }), tools.gate({ n: 2 })])'],
    ['made in one turn with work between them', 'const a = tools.gate({ n: 1 }); let s = 0; for (let i = 0; i < 3e6; i++) s += i; const b = tools.gate({ n: 2 }); await Promise.all([a, b])'],
  ])('hands back the asks of two calls %s, both invoked, when the first asks at once', async (_how, script) => {
    const invoked = vi.fn(async (call: NestedCall) => ask(call))
    const stopped = await codeRun(scratch(), invoked)(script).catch((error: unknown) => error)
    expect(stopped).toBeInstanceOf(NestedApprovalRequired)
    expect((stopped as NestedApprovalRequired).approvals.map(approval => approval.token)).toEqual(['token-1', 'token-2'])
    expect(invoked).toHaveBeenCalledTimes(2)
  })

  it('runs a call of the turn that arrives after an ask, journals it, and replays it on the retry', async () => {
    const directory = scratch()
    const script = 'const a = tools.gate({}); let s = 0; for (let i = 0; i < 3e6; i++) s += i; const b = tools.echo({ n: 2 }); await a; return await b'
    const first = vi.fn(async (call: NestedCall) => call.tool === 'gate' ? ask(call) : ok(call, 'echoed'))
    await expect(codeRun(directory, first)(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    expect(kept(directory).map(journal => journal.entries.map(entry => entry.tool))).toEqual([['echo']])

    const resumed = vi.fn(async (call: NestedCall) => ok(call, 'opened'))
    expect(await codeRun(directory, resumed)(script)).toMatchObject({ ok: true, value: 'echoed' })
    expect(resumed.mock.calls.map(([call]) => call.tool)).toEqual(['gate'])
  })

  // Re-check of round 2, finding journal-turn index.ts:365: on the caller's cancel the record is written before the
  // collected asks are withdrawn, and a withdrawal that fails leaves it in place.
  it('keeps the record before it withdraws the asks of a cancelled caller, and keeps it when the withdrawal fails', async () => {
    const directory = scratch()
    const caller = new AbortController()
    let recordsAtWithdrawal = -1
    const withdrawNested = vi.fn(async () => {
      recordsAtWithdrawal = kept(directory).length
      throw new Error('STATE_BUSY: Buckle state is busy in another process; retry shortly')
    })
    const invoked = async (call: NestedCall): Promise<InvokeResponse> => {
      if (call.tool === 'gate') {
        setTimeout(() => caller.abort(new Error('notifications/cancelled')), 100)
        return ask(call)
      }
      if (call.tool === 'waiter') {
        call.onExecute?.()
        await new Promise(resolve => setTimeout(resolve, 400))
      }
      return ok(call, call.tool)
    }
    const script = 'await tools.echo({ n: 1 }); await Promise.all([tools.gate({}), tools.waiter({})])'
    const result = await codeRun(directory, invoked, { signal: caller.signal, withdrawNested, callerCancelled: () => caller.signal.aborted })(script)

    expect(result).toMatchObject({ ok: false, error: { kind: 'aborted' } })
    expect(withdrawNested).toHaveBeenCalledWith(['token-2'])
    expect(recordsAtWithdrawal).toBe(1)
    const [record] = kept(directory)
    expect(record?.asks).toBeUndefined()
    expect(record?.entries.map(entry => [entry.tool, entry.outcome.ok ? 'ok' : (entry.outcome.properties as { code: string }).code])).toEqual([['echo', 'ok'], ['waiter', 'REQUEST_ALREADY_EXECUTED']])
  })

  // Final review of 0.1.4, finding code index.ts:371: a re-send that stops before it reaches the call that asked keeps
  // naming that ask, which is still pending, so `buckle approvals show` finds the script and a later divergence
  // withdraws the ask.
  it('keeps naming an earlier run\'s ask when a resumed run stops before it reaches that call again', async () => {
    const directory = scratch()
    const script = 'await tools.echo({}); let s = 0; for (let i = 0; i < 3e7; i++) s += i; await tools.gate({}); return s'
    const invoked = async (call: NestedCall) => call.tool === 'gate' ? ask(call) : ok(call, 'echoed')
    await expect(codeRun(directory, invoked)(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    expect(kept(directory).map(journal => journal.asks)).toEqual([['token-2']])

    const withdrawNested = vi.fn(async () => {})
    expect(await codeRun(directory, invoked, { timeoutMs: 300, withdrawNested })(script)).toMatchObject({ ok: false, error: { kind: 'timeout' } })
    expect(kept(directory).map(journal => journal.asks)).toEqual([['token-2']])
    expect(scriptOfAsk(directory, 'token-2')).toBe(script)
    expect(withdrawNested).not.toHaveBeenCalled()

    // Replayed on another VM, the record diverges, and the earlier run's ask goes with it.
    const [file] = readdirSync(directory).filter(name => name.endsWith('.json'))
    writeFileSync(join(directory, file!), JSON.stringify({ ...JSON.parse(readFileSync(join(directory, file!), 'utf8')), vm: 'another-vm' }))
    await expect(codeRun(directory, invoked, { withdrawNested })(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
    expect(withdrawNested).toHaveBeenCalledWith(['token-2'])
    // Recheck 3 of the final review of 0.1.4, finding code index.ts:487: a diverged record is kept until it expires.
    expect(kept(directory)).toHaveLength(1)
  }, 60_000)

  // Final review of 0.1.4, finding code index.ts:365: a withdrawal the approvals lock refuses is logged, and the agent
  // still gets the script's own code, never STATE_BUSY.
  it.each([CODE_REPLAY_DIVERGED, CODE_REPLAY_TOO_LARGE])('answers %s when the withdrawal of its asks fails, and logs it', async (code) => {
    const directory = scratch()
    const busy = vi.fn(async () => { throw new StateBusyError('Buckle state is busy in another process; retry shortly') })
    const warned = vi.spyOn(logger, 'warn')
    if (code === CODE_REPLAY_DIVERGED) {
      const script = 'await tools.echo({}); await tools.gate({})'
      const invoked = async (call: NestedCall) => call.tool === 'gate' ? ask(call) : ok(call, 'echoed')
      await expect(codeRun(directory, invoked)(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
      const [file] = readdirSync(directory).filter(name => name.endsWith('.json'))
      writeFileSync(join(directory, file!), JSON.stringify({ ...JSON.parse(readFileSync(join(directory, file!), 'utf8')), vm: 'another-vm' }))
      await expect(codeRun(directory, invoked, { withdrawNested: busy })(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
      expect(busy).toHaveBeenCalledWith(['token-2'])
      // Recheck 3 of the final review of 0.1.4, finding code index.ts:487: a diverged record is kept until it expires.
      expect(kept(directory)).toHaveLength(1)
    } else {
      const script = 'for (let i = 0; i < 10; i++) await tools.echo({ i }); await tools.gate({})'
      const execute = codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, 'x'.repeat(500)), { journalBytes: 2_048, withdrawNested: busy })
      await expect(execute(script)).rejects.toMatchObject({ code: CODE_REPLAY_TOO_LARGE })
      expect(busy).toHaveBeenCalledWith(['token-11'])
    }
    expect(warned.mock.calls.map(([message]) => message)).toContain(`Could not withdraw the asks of a script ${code === CODE_REPLAY_DIVERGED ? 'that diverged' : 'that cannot resume'}; they stay pending until they expire`)
    warned.mockRestore()
  })

  // Recheck of the final review of 0.1.4, finding code index.ts:174: describeTool and searchTools are answered live on
  // every run, their answers never recorded, and leave the script's clock where it was, so a call after one that reads
  // the clock replays as made. Recheck 2, finding code index.ts:363: each is recorded by its number and fingerprint.
  it('answers globals live on every run, records them by number and fingerprint alone, and the replay still matches', async () => {
    const directory = scratch()
    const script = 'const d = await describeTool("echo"); const a = await tools.echo({ t: Date.now() }); const s = await searchTools("echo"); await tools.gate({}); return [d.includes("echo"), a, s.length]'
    const first = vi.fn(async (call: NestedCall) => call.tool === 'gate' ? ask(call) : ok(call, 'echoed'))
    await expect(codeRun(directory, first)(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    expect(kept(directory).map(journal => journal.entries.map(entry => [entry.seq, entry.tool]))).toEqual([[[2, 'echo']]])
    expect(kept(directory).map(journal => journal.globals?.map(entry => [entry.seq, entry.id, entry.name, Object.keys(entry).sort()]))).toEqual([[
      [1, 1, 'describeTool', ['args', 'id', 'name', 'seq']], [3, 3, 'searchTools', ['args', 'id', 'name', 'seq']],
    ]])

    const resumed = vi.fn(async (call: NestedCall) => ok(call, 'opened'))
    expect(await codeRun(directory, resumed)(script)).toMatchObject({ ok: true, value: [true, 'echoed', 1] })
    expect(resumed.mock.calls.map(([call]) => call.tool)).toEqual(['gate'])
  })

  it('keeps globals out of the record\'s bound, so a script that describes many tools still resumes', async () => {
    const directory = scratch()
    const script = 'for (let i = 0; i < 100; i++) await describeTool("echo"); await tools.echo({}); await tools.gate({}); return "done"'
    await expect(codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, 'echoed'), { journalBytes: 2_048 })(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    expect(kept(directory).map(journal => journal.entries.map(entry => entry.tool))).toEqual([['echo']])
    expect(await codeRun(directory, async call => ok(call, 'opened'), { journalBytes: 2_048 })(script)).toMatchObject({ ok: true, value: 'done' })
  })

  it(`ends a script past ${MAX_GLOBAL_CALLS} global calls with ${CODE_GLOBAL_LIMIT}`, async () => {
    const result = await codeRun(scratch(), async call => ok(call, null))('for (;;) await describeTool("echo")') as { ok: boolean; error?: { kind: string; message: string } }
    expect(result).toMatchObject({ ok: false, error: { kind: 'script', message: expect.stringContaining(`${CODE_GLOBAL_LIMIT}: this script called describeTool and searchTools more than ${MAX_GLOBAL_CALLS} times`) } })
  }, 60_000)

  // Recheck 3 of the final review of 0.1.4, finding journal.ts:197: the record's file bound measures its entries alone,
  // so 10000 globals on top of results just under 32 MiB still leave a script that resumes after its ask.
  it('keeps a record whose results fit the bound whole, whatever its globals add, so the script resumes', async () => {
    const directory = scratch()
    const big = 'x'.repeat(JOURNAL_BYTES - 700 * 1_024)
    const script = 'const a = await tools.echo({}); for (let i = 0; i < 10000; i++) await describeTool("nope"); await tools.gate({}); return a.length'
    await expect(codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, big))(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    const [record] = kept(directory)
    expect([record?.entries[0]?.outcome.ok, record?.globals?.length]).toEqual([true, 10_000])
    expect(await codeRun(directory, async call => ok(call, 'opened'))(script)).toMatchObject({ ok: true, value: big.length })
  }, 120_000)

  // Recheck 3 of the final review of 0.1.4, finding code index.ts:487: a stub record whose replay diverges before any
  // stub is handed, here on another VM, is kept too, so after a restart the third send still runs nothing.
  it('keeps a stub record whose replay diverges before handing out a stub, so the third send runs nothing', async () => {
    const directory = scratch()
    const script = 'for (let i = 0; i < 4; i++) await tools.echo({ i }); while (true) {}'
    expect(await codeRun(directory, async call => ok(call, 'x'.repeat(5_000)), { journalBytes: 8_192, timeoutMs: 1_000 })(script)).toMatchObject({ ok: false, error: { kind: 'timeout' } })
    const [file] = readdirSync(directory).filter(name => name.endsWith('.json'))
    writeFileSync(join(directory, file!), JSON.stringify({ ...JSON.parse(readFileSync(join(directory, file!), 'utf8')), vm: 'another-vm' }))

    const invoked = vi.fn(async (call: NestedCall) => ok(call, 'ran again'))
    for (let send = 2; send <= 3; send++) {
      await expect(codeRun(directory, invoked, { journalBytes: 8_192 })(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
      expect(kept(directory).map(journal => journal.entries.length)).toEqual([4])
    }
    expect(invoked).not.toHaveBeenCalled()
  }, 60_000)

  // Recheck 2 of the final review of 0.1.4, finding code index.ts:477: a script that handles a stub's error and passes it
  // on diverges on it, and the record is kept, so a restart and a third unchanged send still run nothing.
  it('keeps the record of a replay that diverges on a stub the script handled, so the third send runs nothing', async () => {
    const directory = scratch()
    const script = 'const failed = []; for (let i = 0; i < 6; i++) { try { await tools.echo({ i }) } catch (error) { failed.push(i) } } const pushed = await tools.echo({ push: true }).then(() => "pushed", error => "push: " + error.code); await tools.echo({ report: { failed, pushed } }); while (true) {}'
    expect(await codeRun(directory, async call => ok(call, 'x'.repeat(5_000)), { journalBytes: 8_192, timeoutMs: 1_000 })(script)).toMatchObject({ ok: false, error: { kind: 'timeout' } })
    expect(kept(directory).map(journal => journal.entries.length)).toEqual([8])

    const invoked = vi.fn(async (call: NestedCall) => ok(call, 'ran again'))
    for (let send = 2; send <= 3; send++) {
      await expect(codeRun(directory, invoked, { journalBytes: 8_192 })(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
      expect(kept(directory).map(journal => journal.entries.length)).toEqual([8])
    }
    expect(invoked).not.toHaveBeenCalled()
  }, 60_000)

  // Recheck 2 of the final review of 0.1.4, finding code index.ts:363: a global made again with other arguments than its
  // first run's is refused before any call runs.
  it('refuses a replay whose global differs from its first run\'s, before any call runs', async () => {
    const directory = scratch()
    const script = 'await describeTool("echo"); await tools.echo({}); await tools.gate({})'
    await expect(codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, 'echoed'))(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    const [file] = readdirSync(directory).filter(name => name.endsWith('.json'))
    const record = JSON.parse(readFileSync(join(directory, file!), 'utf8')) as Journal
    writeFileSync(join(directory, file!), JSON.stringify({ ...record, globals: record.globals!.map(entry => ({ ...entry, args: '0'.repeat(64) })) }))
    const invoked = vi.fn(async (call: NestedCall) => ok(call, 'opened'))
    await expect(codeRun(directory, invoked)(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
    expect(invoked).not.toHaveBeenCalled()
  })

  // Recheck 3 of the final review of 0.1.4, finding code index.ts:368: a recorded entry the replay never asks for, its
  // number held by the record, leaves the VM waiting: the send is refused once the VM goes idle, not at its deadline.
  it('refuses a replay that never asks for a recorded entry once the VM goes idle', async () => {
    const directory = scratch()
    const script = 'await tools.echo({}); await tools.gate({})'
    await expect(codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, 'echoed'))(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    const [file] = readdirSync(directory).filter(name => name.endsWith('.json'))
    const record = JSON.parse(readFileSync(join(directory, file!), 'utf8')) as Journal
    writeFileSync(join(directory, file!), JSON.stringify({ ...record, entries: record.entries.map(entry => ({ ...entry, id: entry.id + 8 })) }))
    const began = performance.now()
    await expect(codeRun(directory, async call => ok(call, 'opened'), { timeoutMs: 30_000 })(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
    expect(performance.now() - began).toBeLessThan(10_000)
  }, 40_000)

  // A replay that does not make a global its first run made leaves that global's number unfilled: it is refused at
  // once rather than left to wait for the deadline.
  it('refuses a replay that leaves a global of its first run unmade', async () => {
    const directory = scratch()
    const script = 'await tools.echo({}); await tools.gate({})'
    await expect(codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, 'echoed'))(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    const [file] = readdirSync(directory).filter(name => name.endsWith('.json'))
    const record = JSON.parse(readFileSync(join(directory, file!), 'utf8')) as Journal
    writeFileSync(join(directory, file!), JSON.stringify({ ...record, entries: record.entries.map(entry => ({ ...entry, seq: entry.seq + 1 })) }))
    const began = performance.now()
    await expect(codeRun(directory, async call => ok(call, 'opened'), { timeoutMs: 30_000 })(script)).rejects.toMatchObject({ code: CODE_REPLAY_DIVERGED })
    expect(performance.now() - began).toBeLessThan(10_000)
  }, 40_000)

  // Review of the code-mode slice, findings approvals-replay 210, invoker-audit 210, and tests 210.
  it(`holds a script to ${MAX_NESTED_CALLS} calls across its resume after an ask`, async () => {
    const directory = scratch()
    const script = 'for (let i = 0; ; i++) { try { await tools.echo({ i }) } catch (error) { return [i, error.code] } }'
    const first = vi.fn(async (call: NestedCall) => (call.args as { i: number }).i === 199 ? ask(call) : ok(call, null))
    await expect(codeRun(directory, first)(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    expect(first).toHaveBeenCalledTimes(200)

    const resumed = vi.fn(async (call: NestedCall) => ok(call, null))
    expect(await codeRun(directory, resumed)(script)).toMatchObject({ ok: true, value: [MAX_NESTED_CALLS, CODE_CALL_LIMIT] })
    expect(resumed).toHaveBeenCalledTimes(MAX_NESTED_CALLS - 199)
  })

  // Review of the code-mode slice, finding approvals-replay 228.
  it('never journals a call the script\'s end cut, and makes it again when the script is sent again', async () => {
    const directory = scratch()
    const script = 'const waiting = tools.waiter({}); await tools.gate({}); return await waiting'
    // The waiter waits for a person past the script's deadline, and answers as the invoker does once cut.
    const cutAtTheEnd = (call: NestedCall) => call.tool === 'gate' ? Promise.resolve(ask(call)) : new Promise<InvokeResponse>(resolve => call.signal?.addEventListener('abort', () => resolve(cut(call))))
    await expect(codeRun(directory, cutAtTheEnd, { timeoutMs: 1_000 })(script)).rejects.toBeInstanceOf(NestedApprovalRequired)
    expect(kept(directory).map(journal => journal.entries)).toEqual([[]])

    const again = vi.fn(async (call: NestedCall) => ok(call, call.tool))
    expect(await codeRun(directory, again)(script)).toMatchObject({ ok: true, value: 'waiter' })
    expect(again.mock.calls.map(([call]) => call.tool).sort()).toEqual(['gate', 'waiter'])
  })

  it('lets a call already running settle into the journal before the script stops, and replays it after', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-inflight-'))
    roots.push(directory)
    const script = 'const slow = tools.echo({ n: 1 }); await tools.gate({}); return await slow'
    let release: (() => void) | undefined
    // The slow call answers as the invoker does once its signal fires, so a VM stopped before it settles journals a
    // cut call and the replay below fails (review of the code-mode slice, finding tests 242).
    const slow = (call: NestedCall) => new Promise<InvokeResponse>((resolve) => {
      call.signal?.addEventListener('abort', () => resolve(cut(call)))
      release = () => resolve(ok(call, 'slow result'))
    })
    const first = codeRun(directory, call => call.tool === 'gate' ? Promise.resolve(ask(call)) : slow(call))(script)
    await vi.waitFor(() => expect(release).toBeDefined())
    setTimeout(() => release!(), 50)

    await expect(first).rejects.toBeInstanceOf(NestedApprovalRequired)
    const replayed = vi.fn(async (call: NestedCall) => ok(call, 'opened'))
    expect(await codeRun(directory, replayed)(script)).toMatchObject({ ok: true, value: 'slow result' })
    expect(replayed.mock.calls.map(([call]) => call.tool)).toEqual(['gate'])
  })

  it(`fails with ${CODE_REPLAY_TOO_LARGE} when the results before the ask pass the journal's bound`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-large-'))
    roots.push(directory)
    const large = 'x'.repeat(17 * 1_024 * 1_024)
    const script = 'const a = await tools.echo({}); const b = await tools.echo({}); await tools.gate({}); return a.length + b.length'
    const withdrawNested = vi.fn(async () => {})
    const execute = codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, large as JsonObject[keyof JsonObject]), { withdrawNested })

    await expect(execute(script)).rejects.toMatchObject({ code: CODE_REPLAY_TOO_LARGE, retryable: false, message: expect.stringContaining('sent again unchanged they are not run again') })
    // Final review of 0.1.4, finding docs code-mode-02.md:19: the record keeps the calls that ran as stubs, their
    // results dropped, and names no ask, so the script sent again runs neither again.
    expect(kept(directory).map(journal => [journal.asks, journal.entries.map(entry => [entry.tool, entry.outcome.ok ? 'ok' : entry.outcome.properties?.code])])).toEqual([[undefined, [['echo', 'REQUEST_ALREADY_EXECUTED'], ['echo', 'REQUEST_ALREADY_EXECUTED']]]])
    // Review of the code-mode slice, coordinator decision 5: no call will spend the ask, so it is withdrawn.
    expect(withdrawNested).toHaveBeenCalledWith(['token-3'])
    const again = vi.fn(async (call: NestedCall) => ok(call, 'ran again'))
    expect(await codeRun(directory, again)(script)).toMatchObject({ ok: false, error: { kind: 'script', message: expect.stringContaining('REQUEST_ALREADY_EXECUTED') } })
    expect(again).not.toHaveBeenCalled()
  }, 60_000)

  // Review of the code-mode slice, finding tests 163: the bound on results kept in memory holds on its own, before
  // the store's, and an earlier journal of the script goes with it.
  it('stops keeping results in memory past the journal bound, before the store is reached', async () => {
    const directory = scratch()
    const earlier = join(directory, `${'f'.repeat(64)}.json`)
    writeFileSync(earlier, JSON.stringify({ version: 1, key: 'f'.repeat(64), startedAt: 1, seed: 1, tools: [echo, gate, waiter].map(tool => ({ name: tool.name, jsName: tool.name, description: tool.description })), entries: [], expiresAt: Date.now() + 60_000 }))
    const withdrawNested = vi.fn(async () => {})
    const script = 'for (let i = 0; i < 10; i++) await tools.echo({ i }); await tools.gate({})'
    const execute = codeRun(directory, async call => call.tool === 'gate' ? ask(call) : ok(call, 'x'.repeat(500)), { journalBytes: 2_048, withdrawNested })

    // Even as stubs its calls pass this bound, so nothing is kept, and the answer promises nothing of a re-send.
    await expect(execute(script)).rejects.toMatchObject({ code: CODE_REPLAY_TOO_LARGE, message: expect.not.stringContaining('not run again') })
    expect(existsSync(earlier)).toBe(false)
    expect(readdirSync(directory)).toEqual([])
    expect(withdrawNested).toHaveBeenCalledWith(['token-11'])
  })
})
