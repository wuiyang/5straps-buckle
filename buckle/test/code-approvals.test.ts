import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CLIENT_CAPABILITIES_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalWait, InvokeResponse, JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'
import { createPiCodemodeVm } from '../common/adapters/script-vm/pi-codemode.js'
import { NestedApprovalRequired, type NestedCall, type ToolContext } from '../common/domain/tool.js'
import { loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { CODE_CALL_LIMIT, createCodePack, MAX_NESTED_CALLS } from '../common/services/packs/code/index.js'
import { CODE_REPLAY_TOO_LARGE, createJournalStore, JOURNAL_TTL_MS, TEMPORARY_GRACE_MS, type Journal } from '../common/services/packs/code/journal.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
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
      description: `Called by a "code_run" script, stage "stage-a"; buckle approvals show <token> prints the script: Write 5 bytes to "one/out.md" in "${workspace}"`,
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
    await answer(runtime, approval!.token)
    const read = vi.spyOn(runtime.registry().get('fs_read'), 'prepare')

    const retried = await run(runtime, READ_THEN_WRITE, 'stage-b')
    expect(retried).toMatchObject({ outcome: 'ok', output: { ok: true, output: 'written' } })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(read).not.toHaveBeenCalled()
    expect(attempts(runtime, 'fs_read')).toHaveLength(1)
    // One stage for the script, before and after its ask, though the retry carried another (finding docs-rules code-mode.md:111).
    expect(attempts(runtime, 'fs_write').map(entry => entry.stageId)).toEqual(['stage-a', 'stage-a'])
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
    expect(form.params.message).toContain('does:     Called by a "code_run" script, stage')
    expect(form.params.message).toContain('"content": "HELLO"')

    const second = await call({ [token]: { action: 'accept', content: { approve: true, scope: 'once' } } }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(second.isError).not.toBe(true)
    expect(JSON.parse(second.content[0]!.text)).toMatchObject({ ok: true, output: 'written' })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('HELLO')
    expect(attempts(runtime, 'fs_read')).toHaveLength(1)
    // MCP gives each tools/call its own requestId, the stage a script falls back to; the retry keeps the first one.
    const stages = [...attempts(runtime, 'fs_read'), ...attempts(runtime, 'fs_write')].map(entry => entry.stageId)
    expect(new Set(stages).size).toBe(1)
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

    expect(await run(runtime, READ_THEN_WRITE)).toMatchObject({ outcome: 'error', error: { code: 'CODE_REPLAY_DIVERGED', retryable: false } })
    expect(read).not.toHaveBeenCalled()
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

  function codeRun(directory: string, invokeNested: (call: NestedCall) => Promise<InvokeResponse>, input: { timeoutMs?: number; signal?: AbortSignal; forgetNested?: (ids: readonly number[]) => void; withdrawNested?: (tokens: readonly string[]) => Promise<void>; journalBytes?: number } = {}) {
    const pack = createCodePack({ vm: createPiCodemodeVm(), reachableTools: () => [echo, gate, waiter], journalDirectory: directory, unavailableReason: null, ...(input.journalBytes ? { journalBytes: input.journalBytes } : {}) })
    const context: ToolContext = { requestId: 'outer', sessionId: 'chat-1', timeoutMs: input.timeoutMs ?? 60_000, signal: input.signal ?? new AbortController().signal, nestedKey: 'f'.repeat(64), invokeNested, forgetNested: input.forgetNested ?? (() => {}), ...(input.withdrawNested ? { withdrawNested: input.withdrawNested } : {}) }
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
    const ending = async (script: string, input: { timeoutMs?: number; abortAfterCall?: boolean } = {}) => {
      const directory = scratch()
      const caller = new AbortController()
      const forgetNested = vi.fn()
      const echoed = async (call: NestedCall) => {
        if (input.abortAfterCall) setTimeout(() => caller.abort(new Error('stopped by the caller')), 50)
        return ok(call, 'echoed')
      }
      const result = await codeRun(directory, echoed, { ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), signal: caller.signal, forgetNested })(script) as { error?: { kind: string } }
      return { kind: result.error?.kind ?? 'ok', forgotten: forgetNested.mock.calls, journal: kept(directory).map(journal => journal.entries.map(entry => entry.tool)) }
    }

    expect(await ending('await tools.echo({}); return 1')).toEqual({ kind: 'ok', forgotten: [[[1]]], journal: [] })
    expect(await ending('await tools.echo({}); throw new Error("boom")')).toEqual({ kind: 'script', forgotten: [[[1]]], journal: [] })
    expect(await ending('await tools.echo({}); while (true) {}', { timeoutMs: 300 })).toEqual({ kind: 'timeout', forgotten: [], journal: [['echo']] })
    expect(await ending('await tools.echo({}); while (true) {}', { abortAfterCall: true })).toEqual({ kind: 'aborted', forgotten: [], journal: [['echo']] })
  })

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

    await expect(execute(script)).rejects.toMatchObject({ code: CODE_REPLAY_TOO_LARGE, retryable: false })
    expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([])
    // Review of the code-mode slice, coordinator decision 5: no call will spend the ask, so it is withdrawn.
    expect(withdrawNested).toHaveBeenCalledWith(['token-3'])
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

    await expect(execute(script)).rejects.toMatchObject({ code: CODE_REPLAY_TOO_LARGE })
    expect(existsSync(earlier)).toBe(false)
    expect(readdirSync(directory)).toEqual([])
    expect(withdrawNested).toHaveBeenCalledWith(['token-11'])
  })
})
