import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestCli } from '@5straps/runtime'
import type { InvokeRequest, InvokeResponse } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { approvalsPath } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createApprovalRegistry, MAX_PENDING_PER_SESSION, MAX_PENDING_PER_WORKSPACE } from '../common/services/approvals/approval-registry.js'
import { MAX_SESSION_ID } from '../common/services/invocation/invoker.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction, headlessGrace, approvalServiceWithTerminal } from './support/interaction.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

/** A node whose gated calls wait a minute, with two directories a write asks for. */
async function node(interaction = headlessGrace) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-join-'))
  for (const directory of ['workspace', 'workspace/one', 'workspace/two']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
  return { config, runtime: await createRuntime({ config, interaction: fixedInteraction(interaction) }) }
}

const batch = (requestId: string): InvokeRequest => ({ requestId, tool: 'fs_write_batch', args: { files: [{ path: 'one/a.md', content: 'a' }, { path: 'two/b.md', content: 'b' }] }, approvalTokens: [] })
const single = (requestId: string): InvokeRequest => ({ requestId, tool: 'fs_write', args: { path: 'one/a.md', content: 'a' }, approvalTokens: [] })
const outside = (index: number) => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject: `/outside/${index}`, reason: 'outside', offeredScopes: ['once' as const] })

function results(runtime: CoreRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.requestId === requestId)
}

async function answer(runtime: CoreRuntime, token: string, scope: 'once' | 'session' = 'once') {
  expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope }, source: SOURCES.cli })).ok).toBe(true)
}

/** Resolves once the registry has joined a re-sent call to the ask already waiting. */
function joinSeen(runtime: CoreRuntime) {
  const ask = vi.spyOn(runtime.approvals, 'ask')
  return () => vi.waitFor(() => expect(ask.mock.settledResults).toContainEqual({ type: 'fulfilled', value: expect.objectContaining({ joined: true }) }))
}

/** Two callers with one requestId: the second joins once the first is waiting. */
async function joinedPair(runtime: CoreRuntime, request: InvokeRequest): Promise<{ first: Promise<InvokeResponse>; second: Promise<InvokeResponse> }> {
  const first = runtime.invoke({ sessionId: 'chat-1', request })
  await vi.waitFor(() => expect(runtime.approvalService.pending()).not.toHaveLength(0))
  const joined = joinSeen(runtime)
  const second = runtime.invoke({ sessionId: 'chat-1', request })
  await joined()
  return { first, second }
}

describe('a re-sent call joined to a waiting ask (review M1)', () => {
  it('runs once when answered session: the newest caller carries the wait, the earlier one is superseded', async () => {
    const { runtime } = await node()
    const { first, second } = await joinedPair(runtime, single('rings-1'))

    expect(await first).toMatchObject({ outcome: 'error', error: { code: 'REQUEST_SUPERSEDED', retryable: false } })
    await answer(runtime, runtime.approvalService.pending()[0]!.token, 'session')

    expect(await second).toMatchObject({ outcome: 'ok' })
    expect(results(runtime, 'rings-1').map(entry => entry.outcome).sort()).toEqual(['error', 'ok'])
    await runtime.history.close()
  })

  it('reports no denial when answered once: nobody declined it', async () => {
    const { runtime } = await node()
    const { first, second } = await joinedPair(runtime, single('rings-2'))
    await first
    await answer(runtime, runtime.approvalService.pending()[0]!.token)

    expect(await second).toMatchObject({ outcome: 'ok' })
    expect(results(runtime, 'rings-2').map(entry => entry.outcome)).not.toContain('denied')
    await runtime.history.close()
  })

  it('answers a caller whose asks were withdrawn under it as retryable, never as declined', async () => {
    const { runtime } = await node()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: single('rings-3') })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    // Stands in for a caller that left a moment after this one joined, withdrawing the asks they shared.
    await runtime.approvals.cancel(runtime.approvalService.pending().map(request => request.token))

    expect(await waiting).toMatchObject({ outcome: 'error', error: { code: 'APPROVAL_UNANSWERED', retryable: true } })
    expect(results(runtime, 'rings-3').map(entry => entry.outcome)).toEqual(['error'])
    await runtime.history.close()
  })
})

describe('a re-sent call after part of its asks were answered (review M2)', () => {
  it('joins the ask still waiting and runs once that is answered', async () => {
    const { runtime } = await node()
    const first = await runtime.invoke({ sessionId: 'chat-1', request: batch('rings-4'), approvalWait: { mode: 'none' } })
    if (first.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${first.outcome}`)
    const [one, two] = first.approvals
    await answer(runtime, one!.token)

    const joined = joinSeen(runtime)
    const again = runtime.invoke({ sessionId: 'chat-1', request: batch('rings-4') })
    await joined()
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([two!.token])
    await answer(runtime, two!.token)

    expect(await again).toMatchObject({ outcome: 'ok' })
    expect(results(runtime, 'rings-4').map(entry => entry.outcome)).toEqual(['approval_required', 'ok'])
    await runtime.history.close()
  })
})

describe('what the registry keeps about an ask', () => {
  it('stores a caller-chosen requestId as a hash of the whole id, so ids that share a long prefix never join (review L2 of B18-B19)', async () => {
    const { config, runtime } = await node()
    const prefix = 'r'.repeat(5_000)
    await runtime.invoke({ sessionId: 'chat-1', request: single(`${prefix}-a`), approvalWait: { mode: 'none' } })
    await runtime.invoke({ sessionId: 'chat-1', request: single(`${prefix}-b`), approvalWait: { mode: 'none' } })
    const stored = JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as { pending: Array<{ requestId: string }> }
    expect(stored.pending.map(entry => entry.requestId)).toEqual([expect.stringMatching(/^[\da-f]{64}$/), expect.stringMatching(/^[\da-f]{64}$/)])
    expect(new Set(stored.pending.map(entry => entry.requestId)).size).toBe(2)
    await runtime.history.close()
  })

  it(`refuses a session more than ${MAX_PENDING_PER_SESSION} waiting asks, retryable and audited (review L9)`, async () => {
    const { runtime } = await node()
    await runtime.approvals.ask({ tool: 'fs_write', sessionId: 'busy', asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(index)) })

    const refused = await runtime.invoke({ sessionId: 'busy', request: single('one-too-many'), approvalWait: { mode: 'none' } })

    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'APPROVAL_LIMIT', retryable: true } })
    expect(results(runtime, 'one-too-many')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'APPROVAL_LIMIT' })])
    // Another session is not held back by this one.
    expect(await runtime.invoke({ sessionId: 'calm', request: single('calm-1'), approvalWait: { mode: 'none' } })).toMatchObject({ outcome: 'approval_required' })
    await runtime.history.close()
  })

  it(`refuses the workspace more than ${MAX_PENDING_PER_WORKSPACE} waiting asks, whatever session asks (review L2 of B13-B14)`, async () => {
    const { runtime } = await node()
    for (let session = 0; session * MAX_PENDING_PER_SESSION < MAX_PENDING_PER_WORKSPACE; session += 1) {
      await runtime.approvals.ask({ tool: 'fs_write', sessionId: `fresh-${session}`, asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(session * MAX_PENDING_PER_SESSION + index)) })
    }

    const refused = await runtime.invoke({ sessionId: 'never-seen', request: single('workspace-full'), approvalWait: { mode: 'none' } })

    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'APPROVAL_LIMIT', retryable: true, message: expect.stringContaining(`limit ${MAX_PENDING_PER_WORKSPACE}`) } })
    expect(results(runtime, 'workspace-full')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'APPROVAL_LIMIT' })])
    expect(runtime.approvals.pending()).toHaveLength(MAX_PENDING_PER_WORKSPACE)
    await runtime.history.close()
  })

  it(`refuses a session id longer than ${MAX_SESSION_ID} characters before asking anything, and audits the refusal (review L2 of B13-B14)`, async () => {
    const { runtime } = await node()
    const sessionId = `/secret/path/${'s'.repeat(MAX_SESSION_ID)}`

    const refused = await runtime.invoke({ sessionId, request: single('long-session'), approvalWait: { mode: 'none' } })

    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'SESSION_ID_TOO_LONG', retryable: false } })
    if (refused.outcome === 'error') expect(refused.error.message).not.toContain('/secret/path')
    expect(runtime.approvals.pending()).toEqual([])
    expect(results(runtime, 'long-session')).toEqual([expect.objectContaining({ outcome: 'error', sessionId: sessionId.slice(0, MAX_SESSION_ID) })])
    // At the cap exactly, the call goes on to ask.
    expect(await runtime.invoke({ sessionId: 's'.repeat(MAX_SESSION_ID), request: single('at-cap'), approvalWait: { mode: 'none' } })).toMatchObject({ outcome: 'approval_required' })
    await runtime.history.close()
  })
})

describe('the question a hinted call still puts to the terminal (review L3)', () => {
  it('asks the serve terminal about a call whose caller will not wait, and returns at once', async () => {
    const asked: string[] = []
    const requestCli: RequestCli = (request, options) => {
      asked.push(request.id)
      return new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', requestId: request.id, reason: 'withdrawn' }), { once: true }))
    }
    const { runtime } = await node({ hold: 'grace', requestCli })

    const response = await runtime.invoke({ sessionId: 'chat-1', request: single('hinted'), approvalWait: { mode: 'none' } })

    if (response.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${response.outcome}`)
    await vi.waitFor(() => expect(asked).toEqual([`approval:${runtime.workspaceId}:${response.approvals[0]!.token}`]))
    await runtime.approvalService.close()
    await runtime.history.close()
  })

  it('asks the terminal the same whatever the hint says: the hint sets only how long the caller is held (owner ruling of 2026-09-28)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-join-nowait-'))
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'))
    const requestCli = vi.fn<RequestCli>(async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' }))
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: 15_000, interaction: fixedInteraction({ hold: 'grace', requestCli }) })

    for (const [requestId, wait] of [['none', { mode: 'none' }], ['short', { mode: 'finite', ms: 1 }]] as const) {
      expect(await service.request({ sessionId: 's', requestId, tool: 'fs_write', asks: [outside(requestId.length)], wait })).toMatchObject({ settled: false })
    }
    await vi.waitFor(() => expect(requestCli).toHaveBeenCalledTimes(2))
    await service.close()
  })
})

describe('ordering inside a request and at close (review L5)', () => {
  function queue() {
    const root = mkdtempSync(join(tmpdir(), 'buckle-join-order-'))
    return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'))
  }
  const call = { sessionId: 's', requestId: 'r', tool: 'fs_write', asks: [outside(1)], call: { arguments: { path: '/outside/1', content: 'x' }, cwd: '/workspace', description: 'Write to /outside/1', effects: ['write /outside/1'], complete: true as const } }

  it('draws no question for a caller that cancelled while the ask was announced, and withdraws it', async () => {
    const registry = queue()
    const requestCli = vi.fn<RequestCli>(async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' }))
    const leaving = new AbortController()
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: 60_000, interaction: fixedInteraction({ hold: 'grace', requestCli }),
      announce: async () => { leaving.abort() } })

    await expect(service.request({ ...call, signal: leaving.signal, isCancel: () => true })).rejects.toThrow()

    expect(requestCli).not.toHaveBeenCalled()
    expect(registry.pending()).toEqual([])
  })

  it('keeps the ask of a caller whose transport dropped while it was announced, and a grace terminal still asks (owner decision D4)', async () => {
    const registry = queue()
    const requestCli = vi.fn<RequestCli>(async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' }))
    const dropped = new AbortController()
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: 60_000, interaction: fixedInteraction({ hold: 'grace', requestCli }),
      announce: async () => { dropped.abort() } })

    await expect(service.request({ ...call, signal: dropped.signal })).rejects.toThrow()

    expect(registry.pending()).toHaveLength(1)
    await vi.waitFor(() => expect(requestCli).toHaveBeenCalledTimes(1))
    await service.close()
  })

  it('lets a terminal answer already being recorded finish before close returns', async () => {
    const registry = queue()
    const recording = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const slowRegistry = { ...registry, resolve: async (...args: Parameters<typeof registry.resolve>) => { entered.resolve(); await recording.promise; return registry.resolve(...args) } }
    const requestCli: RequestCli = async request => ({ status: 'answered', requestId: request.id, answer: { choice: 'once' } })
    const service = approvalServiceWithTerminal({ registry: slowRegistry, workspaceId: 'default', serverId: 'test-node', graceMs: 60_000, interaction: fixedInteraction({ hold: 'grace', requestCli }) })
    const waiting = service.request(call)
    await entered.promise

    let closed = false
    const closing = service.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    recording.resolve()
    await closing

    expect(registry.pending()).toEqual([])
    expect(registry.unspent('s')).toEqual([{ subject: { rule: 'write_scope', subject: '/outside/1' }, tool: 'fs_write' }])
    expect(await waiting).toMatchObject({ settled: false })
  })
})

describe('a waiting caller whose re-send ran while it waited (review L6 of B23-B25)', () => {
  it('answers with that run, never APPROVAL_UNANSWERED, when the answer came from another process', async () => {
    const { runtime } = await node()
    const request = single('out-of-process-1')
    const first = runtime.invoke({ sessionId: 'chat-1', request })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    // Another process (buckle approve) answers: the registry records it, and this process sees it only at its next poll.
    expect((await runtime.approvals.resolve({ token: runtime.approvalService.pending()[0]!.token, approved: true, scope: 'once' }, SOURCES.cli))).toMatchObject({ ok: true })
    // The caller's re-send arrives first, spends the answer and runs.
    const again = await runtime.invoke({ sessionId: 'chat-1', request })
    expect(again).toMatchObject({ outcome: 'ok' })
    expect(await first).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(runtime.paths().root, 'one', 'a.md'), 'utf8')).toBe('a')
    // It ran once; the waiting caller was answered with that run.
    expect(results(runtime, 'out-of-process-1').filter(entry => entry.outcome === 'ok' && entry.detail === undefined)).toHaveLength(1)
  })
})
