import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationScope, runInScope } from '@5straps/runtime'
import type { InvokeRequest, InvokeResponse } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { createExecutions, EXECUTION_LIMIT, EXECUTION_TTL_MS, REQUEST_ALREADY_EXECUTED, REQUEST_ID_REUSED, requestFingerprint } from '../common/services/invocation/executions.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction, headlessGrace } from './support/interaction.js'

// Review M2 of B13-B14 (plan corrections): a re-send never runs a call twice, beyond the approval wait
// (nitro/coordination.md, Completion and queue: "Reconnection must not execute a request twice").

async function node() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-dedupe-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
  writeFileSync(join(root, 'workspace', 'note.md'), 'first body')
  const runtime = await createRuntime({ config, interaction: fixedInteraction(headlessGrace) })
  return { root, workspace: join(root, 'workspace'), runtime }
}

/** A read inside the workspace needs no approval; a write outside it asks. */
const read = (requestId: string): InvokeRequest => ({ requestId, tool: 'fs_read', args: { path: 'note.md' }, approvalTokens: [] })
const write = (requestId: string, path: string): InvokeRequest => ({ requestId, tool: 'fs_write', args: { path, content: 'written' }, approvalTokens: [] })

/**
 * Counts the times the tool itself runs, and can hold each run until released; a held run ends early
 * when its call is cancelled, as a tool honouring its signal does.
 */
function watchRuns(runtime: BuckleRuntime, tool: string, options: { hold?: boolean } = {}) {
  const gate = Promise.withResolvers<void>()
  let runs = 0
  const registered = runtime.registry().get(tool)
  const prepare = registered.prepare.bind(registered)
  vi.spyOn(registered, 'prepare').mockImplementation((args) => {
    const prepared = prepare(args)
    return { ...prepared, execute: async (context) => {
      runs += 1
      if (options.hold) await Promise.race([gate.promise, new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))])
      return prepared.execute(context)
    } }
  })
  return { runs: () => runs, release: () => gate.resolve() }
}

function results(runtime: BuckleRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.requestId === requestId)
}

function asActor<T>(actor: string, run: () => Promise<T>): Promise<T> {
  return runInScope(createOperationScope({ owner: Symbol('dedupe-test'), context: { actor } }), run)
}

describe('execution dedupe by requestId (review M2 of B13-B14)', () => {
  it('answers a re-send while the call runs with the same response once it settles, and runs the tool once', async () => {
    const { runtime } = await node()
    const runs = watchRuns(runtime, 'fs_read', { hold: true })
    const first = runtime.invoke({ sessionId: 'chat-1', request: read('rings-1') })
    await vi.waitFor(() => expect(runs.runs()).toBe(1))

    const second = runtime.invoke({ sessionId: 'chat-1', request: read('rings-1') })
    runs.release()

    const [one, two] = await Promise.all([first, second])
    expect(one).toMatchObject({ outcome: 'ok' })
    expect(two).toEqual(one)
    expect(runs.runs()).toBe(1)
    expect(results(runtime, 'rings-1').map(entry => entry.detail ?? 'ran')).toEqual(['ran', 'REPLAYED'])
  })

  it('answers a re-send after the call settled with its kept response, without asking or running again', async () => {
    const { runtime, workspace } = await node()
    const runs = watchRuns(runtime, 'fs_read')
    const first = await runtime.invoke({ sessionId: 'chat-1', request: read('rings-2') })
    writeFileSync(join(workspace, 'note.md'), 'second body')
    const second = await runtime.invoke({ sessionId: 'chat-1', request: read('rings-2') })

    expect(first).toMatchObject({ outcome: 'ok', output: { content: 'first body' } })
    expect(second).toEqual(first)
    expect(runs.runs()).toBe(1)
    expect(results(runtime, 'rings-2').map(entry => `${entry.outcome}:${entry.detail ?? 'ran'}`)).toEqual(['ok:ran', 'ok:REPLAYED'])
  })

  it('does not run again after a session grant would allow it: the re-send gets the first run', async () => {
    const { root, runtime } = await node()
    const runs = watchRuns(runtime, 'fs_write')
    const request = write('rings-3', join(root, 'outside.md'))
    const first = runtime.invoke({ sessionId: 'chat-1', request })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    const [ask] = runtime.approvalService.pending()
    expect((await runtime.approvalService.answer({ decision: { token: ask!.token, approved: true, scope: 'session' }, authority: 'admin' })).ok).toBe(true)
    expect(await first).toMatchObject({ outcome: 'ok' })

    expect(await runtime.invoke({ sessionId: 'chat-1', request })).toMatchObject({ outcome: 'ok' })
    expect(runs.runs()).toBe(1)
    expect(results(runtime, 'rings-3').filter(entry => entry.detail === 'REPLAYED')).toHaveLength(1)
    // A new requestId is a new call, which the session grant lets run.
    expect(await runtime.invoke({ sessionId: 'chat-1', request: { ...request, requestId: 'rings-3b' } })).toMatchObject({ outcome: 'ok' })
    expect(runs.runs()).toBe(2)
  })

  it('tells a re-send of a call cancelled while its tool ran that it already ran, with unknown effects, and runs nothing', async () => {
    const { runtime } = await node()
    const runs = watchRuns(runtime, 'fs_read', { hold: true })
    const caller = new AbortController()
    const first = runtime.invoke({ sessionId: 'chat-1', request: read('rings-4'), signal: caller.signal })
    await vi.waitFor(() => expect(runs.runs()).toBe(1))
    caller.abort()
    expect(await first).toMatchObject({ outcome: 'error' })

    const second = await runtime.invoke({ sessionId: 'chat-1', request: read('rings-4') })
    expect(second).toMatchObject({ outcome: 'error', error: { code: REQUEST_ALREADY_EXECUTED, retryable: false, details: { reason: 'interrupted', auditId: expect.any(String) } } })
    expect(runs.runs()).toBe(1)
  })

  it('treats the same requestId from another session or another actor as a different call', async () => {
    const { runtime } = await node()
    const runs = watchRuns(runtime, 'fs_read')
    await runtime.invoke({ sessionId: 'chat-1', request: read('rings-5') })
    await runtime.invoke({ sessionId: 'chat-2', request: read('rings-5') })
    expect(runs.runs()).toBe(2)

    await asActor('agent:one', () => runtime.invoke({ sessionId: 'chat-3', request: read('rings-6') }))
    await asActor('agent:two', () => runtime.invoke({ sessionId: 'chat-3', request: read('rings-6') }))
    expect(runs.runs()).toBe(4)
    await asActor('agent:one', () => runtime.invoke({ sessionId: 'chat-3', request: read('rings-6') }))
    expect(runs.runs()).toBe(4)
  })

  it('refuses the same requestId for another call from the same session, which does not run', async () => {
    const { runtime } = await node()
    const runs = watchRuns(runtime, 'fs_read')
    await runtime.invoke({ sessionId: 'chat-1', request: read('rings-8') })
    const reused = await runtime.invoke({ sessionId: 'chat-1', request: { ...read('rings-8'), args: { path: 'other.md' } } })
    expect(reused).toMatchObject({ outcome: 'error', error: { code: REQUEST_ID_REUSED, retryable: false } })
    expect(runs.runs()).toBe(1)
    expect(results(runtime, 'rings-8').map(entry => entry.detail ?? 'ran')).toEqual(['ran', REQUEST_ID_REUSED])
  })

  it('keeps nothing for a call that did not run: a re-send after approval_required asks again', async () => {
    const { root, runtime } = await node()
    const runs = watchRuns(runtime, 'fs_write')
    const request = write('rings-7', join(root, 'outside.md'))
    const waiting = runtime.invoke({ sessionId: 'chat-1', request, approvalWait: { mode: 'none' } })
    expect(await waiting).toMatchObject({ outcome: 'approval_required' })
    expect(await runtime.invoke({ sessionId: 'chat-1', request, approvalWait: { mode: 'none' } })).toMatchObject({ outcome: 'approval_required' })
    expect(runs.runs()).toBe(0)
    expect(results(runtime, 'rings-7').filter(entry => entry.detail === 'REPLAYED')).toEqual([])
  })
})

describe('shutdown\'s tool calls step (B19)', () => {
  it('cancels a running call, which answers before the step ends, and refuses later calls without running them', async () => {
    const { runtime } = await node()
    const runs = watchRuns(runtime, 'fs_read', { hold: true })
    const running = runtime.invoke({ sessionId: 'chat-1', request: read('running') })
    await vi.waitFor(() => expect(runs.runs()).toBe(1))
    let answered = false
    void running.then(() => { answered = true })

    await runtime.cancelInvocations()

    expect(answered).toBe(true)
    expect(await running).toMatchObject({ outcome: 'error', error: { code: 'BUCKLE_SHUTTING_DOWN', retryable: false } })
    expect(await runtime.invoke({ sessionId: 'chat-1', request: read('late') })).toMatchObject({ outcome: 'error', error: { code: 'BUCKLE_SHUTTING_DOWN' } })
    expect(runs.runs()).toBe(1)
    expect(results(runtime, 'late')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'BUCKLE_SHUTTING_DOWN' })])
  })
})

describe('the execution store', () => {
  const response = (requestId: string, output: unknown = 'done'): InvokeResponse => ({ requestId, outcome: 'ok', output: output as never, meta: { durationMs: 1, truncated: false } })
  const key = (requestId: string, fingerprint = 'same call') => ({ sessionId: 's', requestId, fingerprint })

  function ran(executions: ReturnType<typeof createExecutions>, requestId: string, answer = response(requestId)): void {
    const claim = executions.claim(key(requestId))
    if (claim.kind !== 'owner') throw new Error('expected to own the execution')
    claim.execution.started()
    claim.execution.settle({ response: answer, auditId: `audit-${requestId}`, callerLeft: false })
  }

  async function replayed(executions: ReturnType<typeof createExecutions>, requestId: string): Promise<InvokeResponse | undefined> {
    const earlier = executions.earlier(key(requestId))
    return earlier?.kind === 'replay' ? earlier.response : undefined
  }

  it('forgets a finished call after the kept time', async () => {
    let now = 0
    const executions = createExecutions({ now: () => now })
    ran(executions, 'r1')
    expect(await replayed(executions, 'r1')).toEqual(response('r1'))
    now += EXECUTION_TTL_MS
    expect(executions.earlier(key('r1'))).toBeUndefined()
  })

  it('keeps the newest calls up to its limit', () => {
    const executions = createExecutions()
    for (let index = 0; index <= EXECUTION_LIMIT; index += 1) ran(executions, `r${index}`)
    expect(executions.earlier(key('r0'))).toBeUndefined()
    expect(executions.earlier(key(`r${EXECUTION_LIMIT}`))).toBeDefined()
  })

  it('keeps a large response as a stub naming its audit entry', async () => {
    const executions = createExecutions()
    ran(executions, 'big', response('big', 'x'.repeat(300_000)))
    expect(await replayed(executions, 'big')).toMatchObject({ outcome: 'error', error: { code: REQUEST_ALREADY_EXECUTED, details: { auditId: 'audit-big', reason: 'too_large' } } })
  })

  it('refuses a requestId reused for a different call instead of answering with the other call\'s outcome', () => {
    const executions = createExecutions()
    ran(executions, 'r1')
    expect(executions.earlier(key('r1', 'another call'))).toEqual({ kind: 'reused' })
    expect(requestFingerprint({ tool: 'fs_read', args: { a: 1, b: { c: 2, d: 3 } } })).toBe(requestFingerprint({ tool: 'fs_read', args: { b: { d: 3, c: 2 }, a: 1 } }))
    expect(requestFingerprint({ tool: 'fs_read', args: { a: 1 } })).not.toBe(requestFingerprint({ tool: 'fs_read', args: { a: 2 } }))
  })

  it('keeps nothing for a claimed call whose tool never started, and answers its waiters with its response', async () => {
    const executions = createExecutions()
    const claim = executions.claim(key('busy'))
    if (claim.kind !== 'owner') throw new Error('expected to own the execution')
    const waiter = executions.claim(key('busy'))
    const busy: InvokeResponse = { requestId: 'busy', outcome: 'error', error: { code: 'STATE_BUSY', message: 'busy', retryable: true } }
    claim.execution.settle({ response: busy, auditId: 'a', callerLeft: false })
    expect(waiter.kind === 'replay' && await waiter.response).toEqual(busy)
    expect(executions.earlier(key('busy'))).toBeUndefined()
  })
})
