import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeRequest } from '@5straps/protocol'
import { APPROVAL_NO_DEADLINE } from '@5straps/protocol'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { APPROVAL_OUTBOX_COUNT_MAX, APPROVAL_OUTBOX_RETENTION_MS, createApprovalRegistry, MAX_PENDING_BYTES_PER_ACTOR, MAX_PENDING_BYTES_PER_SESSION, MAX_PENDING_PER_SESSION, MAX_PENDING_PER_WORKSPACE } from '../common/services/approvals/approval-registry.js'

import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { activeWorkDirectory, executingMarks } from '../common/services/workspaces/active-work.js'
import { fixedInteraction, approvalServiceWithTerminal } from './support/interaction.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { auditEntries, startActionLogWriter } from './support/action-log-writer.js'

// The MCP asks brief, item 5: a call whose caller left before its hold ended did not run, and its audit entry says so in a
// code of its own; its ask is marked abandoned, stays answerable for the join window, and makes room under the caps.

async function node(wait = '60000') {
  const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-'))
  for (const directory of ['workspace', 'workspace/one']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: wait })
  return { root, config, runtime: await createRuntime({ config, interaction: fixedInteraction() }) }
}

const write = (requestId: string, path = 'one/a.md'): InvokeRequest => ({ requestId, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] })

const MINUTE = 60_000

// The writer's thread starts on its first write, which the first call's wait for its ask would otherwise include.
beforeAll(startActionLogWriter)
afterEach(() => { vi.useRealTimers() })

/** Moves the wall clock the asks' expiries are read on, and nothing else, so the node's own timers keep running. */
function clockAt(time: number): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(time)
}

function queue() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-queue-'))
  return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), null)
}

const outside = (index: number) => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject: `/outside/${index}`, reason: 'outside', offeredScopes: ['once' as const] })

async function results(runtime: BuckleRuntime, requestId: string) {
  return (await auditEntries(runtime.actions, 200)).filter(entry => entry.event === 'result' && entry.requestId === requestId)
}

describe('a call whose caller left while it waited for a person', () => {
  it('answers CALLER_LEFT, audits that it did not run under that code, and keeps its ask', async () => {
    const { runtime } = await node()
    const leaving = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('left-1'), signal: leaving.signal })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    leaving.abort()

    expect(await waiting).toMatchObject({ outcome: 'error', error: { code: 'CALLER_LEFT', retryable: true } })
    expect(await results(runtime, 'left-1')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'CALLER_LEFT' })])
    expect(runtime.approvalService.pending()).toHaveLength(1)
    await runtime.history.close()
  })

  it('answers CALLER_CANCELLED where the caller cancelled it explicitly, which withdraws its ask', async () => {
    const { runtime } = await node()
    const cancelling = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('cancelled-1'), signal: cancelling.signal, isCancel: () => true })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    cancelling.abort()

    expect(await waiting).toMatchObject({ outcome: 'error', error: { code: 'CALLER_CANCELLED' } })
    expect(await results(runtime, 'cancelled-1')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'CALLER_CANCELLED' })])
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })
})

describe('an abandoned ask', () => {
  it('stays answerable for the join window, ten minutes, and lapses with it', async () => {
    const start = Date.now()
    const { runtime } = await node()
    const leaving = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('left-2'), signal: leaving.signal })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    leaving.abort()
    await waiting

    const [kept] = runtime.approvalService.waiting()
    expect(kept).toMatchObject({ abandonedAt: expect.any(String) })
    clockAt(start + 9 * MINUTE)
    expect(runtime.approvalService.pending()).toHaveLength(1)
    clockAt(start + 11 * MINUTE)
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })

  it('is answered within that window as any waiting ask is', async () => {
    const start = Date.now()
    const { runtime } = await node()
    const leaving = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('left-3'), signal: leaving.signal })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    leaving.abort()
    await waiting

    clockAt(start + 9 * MINUTE)
    const [token] = runtime.approvalService.pending().map(request => request.token)
    expect(await runtime.approvalService.answer({ decision: { token: token!, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    await runtime.history.close()
  })

  it(`never fills a session's ${MAX_PENDING_PER_SESSION} asks alone: the oldest abandoned one makes room, and is withdrawn`, async () => {
    const registry = queue()
    const asked = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(index)), holdMs: 30_000 })
    await registry.holdEnded({ tokens: asked.requests.map(request => request.token), abandoned: true })

    const fresh = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(MAX_PENDING_PER_SESSION)], holdMs: 30_000 })

    expect(fresh.joined).toBe(false)
    expect(fresh.evicted).toHaveLength(1)
    expect(registry.pending()).toHaveLength(MAX_PENDING_PER_SESSION)
    expect(registry.pending().map(request => request.token)).toContain(fresh.requests[0]!.token)
  })

  it(`never fills the workspace's ${MAX_PENDING_PER_WORKSPACE} asks alone either`, async () => {
    const registry = queue()
    for (let session = 0; session * MAX_PENDING_PER_SESSION < MAX_PENDING_PER_WORKSPACE; session += 1) {
      const asked = await registry.ask({ tool: 'fs_write', sessionId: `left-${session}`, asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(session * MAX_PENDING_PER_SESSION + index)), holdMs: 30_000 })
      await registry.holdEnded({ tokens: asked.requests.map(request => request.token), abandoned: true })
    }
    expect((await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(MAX_PENDING_PER_WORKSPACE)], holdMs: 30_000 })).evicted).toHaveLength(1)
  })

  it('makes room from its own workspace\'s abandoned asks alone, where two workspaces share one queue file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-shared-'))
    const keyed = (workspace: string) => createFileGrantStore({ filePath: join(root, 'grants.json'), workspace })
    const other = createApprovalRegistry(keyed('other'), join(root, 'approvals.json'), null)
    const own = createApprovalRegistry(keyed('own'), join(root, 'approvals.json'), null)
    const older = await other.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(0)], holdMs: 30_000 })
    await other.holdEnded({ tokens: older.requests.map(request => request.token), abandoned: true })
    const asked = await own.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(index)), holdMs: 30_000 })
    await own.holdEnded({ tokens: asked.requests.map(request => request.token), abandoned: true })

    expect((await own.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(MAX_PENDING_PER_SESSION)], holdMs: 30_000 })).evicted).toEqual([asked.requests[0]!.token])
    expect(other.pending().map(request => request.token)).toEqual(older.requests.map(request => request.token))
  })

  // Review of the MCP asks slice, finding minor-5: every other test abandons its asks in one call, at one time.
  it('withdraws the oldest abandoned ask first, by when its caller left', async () => {
    const registry = queue()
    const older = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(0)], holdMs: 30_000 })
    await registry.holdEnded({ tokens: older.requests.map(request => request.token), abandoned: true })
    clockAt(Date.now() + 1_000)
    const newer = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION - 1 }, (_, index) => outside(index + 1)), holdMs: 30_000 })
    await registry.holdEnded({ tokens: newer.requests.map(request => request.token), abandoned: true })

    const fresh = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(99)], holdMs: 30_000 })
    expect(fresh.evicted).toEqual(older.requests.map(request => request.token))
  })

  // Finding minor-6: a re-send that joins an abandoned ask holds it again, so a cap must not withdraw it for room.
  it('no longer withdraws an abandoned ask a re-send joined to make room', async () => {
    const registry = queue()
    const first = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', requestId: 'r-a', asks: [outside(0)], holdMs: 30_000 })
    await registry.holdEnded({ tokens: first.requests.map(request => request.token), abandoned: true })
    const rejoined = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', requestId: 'r-a', asks: [outside(0)], holdMs: 30_000 })
    expect(rejoined.joined).toBe(true)
    await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION - 1 }, (_, index) => outside(index + 1)), holdMs: 30_000 })

    await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(99)], holdMs: 30_000 })).rejects.toThrow(/limit 50/)
    expect(registry.pending().map(request => request.token)).toContain(first.requests[0]!.token)
  })

  it('still refuses a session full of asks a caller holds or was answered about, as before', async () => {
    const registry = queue()
    await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(index)), holdMs: 30_000 })
    await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(MAX_PENDING_PER_SESSION)], holdMs: 30_000 })).rejects.toThrow(/limit 50/)
  })
})

// Review of the MCP asks slice, finding M3: only a face that sends a call again (`resends`: the MCP faces and the files
// route) lapses an ask that states no deadline. /v1/invoke, which Rings parks runs on, keeps such an ask until answered.
describe('an ask at wait 0', () => {
  it('states no deadline, and lapses ten minutes after its hold ended', async () => {
    const start = Date.now()
    const { runtime } = await node('0')
    const response = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-1'), approvalWait: { mode: 'finite', ms: 50 }, resends: true })
    if (response.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${response.outcome}`)
    expect(response.approvals[0]!.expiresAt).toBe(APPROVAL_NO_DEADLINE)

    clockAt(start + 9 * MINUTE)
    expect(runtime.approvalService.pending()).toHaveLength(1)
    clockAt(start + 11 * MINUTE)
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })

  it('lapses ten minutes after a call that would not wait returned', async () => {
    const start = Date.now()
    const { runtime } = await node('0')
    const first = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-2'), approvalWait: { mode: 'none' }, resends: true })
    if (first.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${first.outcome}`)
    expect(first.approvals[0]!.expiresAt).toBe(APPROVAL_NO_DEADLINE)

    clockAt(start + 9 * MINUTE)
    expect(runtime.approvalService.pending()).toHaveLength(1)
    clockAt(start + 11 * MINUTE)
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })

  it('restarts its clock when a re-send joins it', async () => {
    const start = Date.now()
    const { runtime } = await node('0')
    await runtime.invoke({ sessionId: 'chat-1', request: write('zero-3'), approvalWait: { mode: 'none' }, resends: true })
    clockAt(start + 9 * MINUTE)
    const again = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-3'), approvalWait: { mode: 'none' }, resends: true })
    expect(again).toMatchObject({ outcome: 'approval_required' })

    clockAt(start + 15 * MINUTE)
    expect(runtime.approvalService.pending()).toHaveLength(1)
    clockAt(start + 20 * MINUTE)
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })

  it.each([['a finite hold', { mode: 'finite', ms: 50 }], ['a call that would not wait', { mode: 'none' }]] as const)('keeps living until answered on a face that does not send the call again (/v1/invoke), after %s', async (_, approvalWait) => {
    const start = Date.now()
    const { runtime } = await node('0')
    const response = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-rpc'), approvalWait })
    if (response.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${response.outcome}`)
    expect(response.approvals[0]!.expiresAt).toBe(APPROVAL_NO_DEADLINE)

    clockAt(start + 3 * 60 * MINUTE)
    const [token] = runtime.approvalService.pending().map(request => request.token)
    expect(token).toBe(response.approvals[0]!.token)
    expect(await runtime.approvalService.answer({ decision: { token: token!, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    await runtime.history.close()
  })

  it('held until decided, still lapses ten minutes after its caller left, on any face', async () => {
    const start = Date.now()
    const { runtime } = await node('0')
    const leaving = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('zero-4'), signal: leaving.signal })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    clockAt(start + 30 * MINUTE)
    // Still held: no lapse while a caller waits on it.
    expect(runtime.approvalService.pending()).toHaveLength(1)
    leaving.abort()
    await waiting
    clockAt(start + 39 * MINUTE)
    expect(runtime.approvalService.pending()).toHaveLength(1)
    clockAt(start + 41 * MINUTE)
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })

  // Two processes can hold one caller's call, as a re-send that reached a second node process joins the first one's ask.
  it('starts no lapse while a call in another process still holds it, and starts it as the last hold anywhere ends', async () => {
    const start = Date.now()
    const { config, runtime: first } = await node('0')
    const second = await createRuntime({ config, interaction: fixedInteraction() })
    const leaving = [new AbortController(), new AbortController()]
    const firstHeld = first.invoke({ sessionId: 'mcp', request: write('shared-1'), signal: leaving[0]!.signal, resends: true })
    await vi.waitFor(() => expect(first.approvalService.pending()).toHaveLength(1))
    const secondHeld = second.invoke({ sessionId: 'mcp', request: write('shared-1'), signal: leaving[1]!.signal, resends: true })
    await vi.waitFor(() => expect(executingMarks({ directory: activeWorkDirectory(config.nodeStateDirectory ?? config.stateDirectory, first.workspaceId) })).toHaveLength(2))

    leaving[0]!.abort()
    expect(await firstHeld).toMatchObject({ outcome: 'error', error: { code: 'CALLER_LEFT' } })
    const [kept] = second.approvalService.waiting()
    expect(kept).not.toHaveProperty('lapsesAt')
    expect(kept).not.toHaveProperty('abandonedAt')
    clockAt(start + 11 * MINUTE)
    expect(second.approvalService.pending()).toHaveLength(1)

    leaving[1]!.abort()
    expect(await secondHeld).toMatchObject({ outcome: 'error', error: { code: 'CALLER_LEFT' } })
    expect(second.approvalService.waiting()[0]).toMatchObject({ abandonedAt: expect.any(String), lapsesAt: expect.any(String) })
    clockAt(start + 20 * MINUTE)
    expect(second.approvalService.pending()).toHaveLength(1)
    clockAt(start + 22 * MINUTE)
    expect(second.approvalService.pending()).toEqual([])
    await first.history.close()
    await second.history.close()
  })

  // A script's call (owner decision D82) waits no later than its script's deadline: held until answered by the node, its
  // hold still ends, and its ask lapses ten minutes after, whether the deadline left it some wait or none.
  it.each([['some wait', 50], ['no wait', -1]] as const)('held until answered within a script\'s deadline, with %s left, lapses ten minutes after', async (_, leftMs) => {
    const start = Date.now()
    const registry = queue()
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: null, interaction: fixedInteraction() })
    const waited = await service.request({ sessionId: 's', requestId: `script-${leftMs}`, tool: 'fs_write', asks: [outside(1)], holdUntil: performance.now() + leftMs, resends: true })
    expect(waited.settled).toBe(false)
    clockAt(start + 9 * MINUTE)
    expect(registry.pending()).toHaveLength(1)
    clockAt(start + 11 * MINUTE)
    expect(registry.pending()).toEqual([])
    await service.close()
  })

  it.each([['some wait', 50], ['no wait', -1]] as const)('held until answered within a script\'s deadline, with %s left, lives on where the face does not send the call again', async (_, leftMs) => {
    const start = Date.now()
    const registry = queue()
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: null, interaction: fixedInteraction() })
    const waited = await service.request({ sessionId: 's', requestId: `script-rpc-${leftMs}`, tool: 'fs_write', asks: [outside(1)], holdUntil: performance.now() + leftMs })
    expect(waited.settled).toBe(false)
    clockAt(start + 3 * 60 * MINUTE)
    expect(registry.pending()).toHaveLength(1)
    await service.close()
  })

  it('takes a call that holds an abandoned ask again out of the abandoned, and out of its lapse, on a face that does not send the call again', async () => {
    const start = Date.now()
    const registry = queue()
    const first = await registry.ask({ tool: 'fs_write', sessionId: 'rpc', requestId: 'r-rpc', asks: [outside(0)] })
    await registry.holdEnded({ tokens: first.requests.map(request => request.token), abandoned: true })
    expect(registry.waiting()[0]).toMatchObject({ abandonedAt: expect.any(String), lapsesAt: expect.any(String) })

    const rejoined = await registry.ask({ tool: 'fs_write', sessionId: 'rpc', requestId: 'r-rpc', asks: [outside(0)] })
    expect(rejoined.joined).toBe(true)
    expect(registry.waiting()[0]).not.toHaveProperty('abandonedAt')
    expect(registry.waiting()[0]).not.toHaveProperty('lapsesAt')
    clockAt(start + 3 * 60 * MINUTE)
    expect(registry.pending()).toHaveLength(1)
  })
})

// Finding minor-4: the caps the builder's eviction covers besides the count of asks in a session and a workspace. The
// asks here are large (a long reason) so a few of them fill a byte budget; the budgets are the registry's own.
describe('an abandoned ask under the other caps', () => {
  const MEGABYTE = 1_000_000
  const large = (index: number, bytes: number) => ({ ...outside(index), reason: `${index}:${'x'.repeat(bytes)}` })
  const asking = (registry: ReturnType<typeof queue>, input: { session: string; actor?: string; index: number; bytes: number }) =>
    registry.ask({ tool: 'fs_write', sessionId: input.session, asks: [large(input.index, input.bytes)], holdMs: 30_000, ...(input.actor === undefined ? {} : { actor: input.actor }) })
  const abandon = (registry: ReturnType<typeof queue>, asked: { requests: Array<{ token: string }> }) => registry.holdEnded({ tokens: asked.requests.map(request => request.token), abandoned: true })

  it(`withdraws the oldest abandoned ask of a session when its ${MAX_PENDING_BYTES_PER_SESSION} bytes are full`, async () => {
    const registry = queue()
    const older = await asking(registry, { session: 'mcp', index: 0, bytes: 10 * MEGABYTE })
    await abandon(registry, older)

    const fresh = await asking(registry, { session: 'mcp', index: 1, bytes: 10 * MEGABYTE })
    expect(fresh.evicted).toEqual(older.requests.map(request => request.token))
    expect(registry.pending().map(request => request.token)).toEqual(fresh.requests.map(request => request.token))
  })

  it(`withdraws the oldest abandoned ask of the same caller across its sessions when the caller's ${MAX_PENDING_BYTES_PER_ACTOR} bytes are full, and no other caller's`, async () => {
    const registry = queue()
    const another = await registry.ask({ tool: 'fs_write', sessionId: 's0', asks: [outside(100)], holdMs: 30_000, actor: 'agent:another' })
    await abandon(registry, another)
    const oldest = await asking(registry, { session: 's1', actor: 'agent:mine', index: 0, bytes: 12 * MEGABYTE })
    await abandon(registry, oldest)
    await asking(registry, { session: 's2', actor: 'agent:mine', index: 1, bytes: 12 * MEGABYTE })

    // Its own session has room, so only the caller's budget refuses.
    const fresh = await asking(registry, { session: 's3', actor: 'agent:mine', index: 2, bytes: 12 * MEGABYTE })
    expect(fresh.evicted).toEqual(oldest.requests.map(request => request.token))
    expect(registry.pending().map(request => request.token)).toContain(another.requests[0]!.token)
    expect(registry.pending()).toHaveLength(3)
  })

  it('withdraws abandoned asks when the outbox of undelivered notices has no room for another ask, and tells it cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-outbox-'))
    const file = join(root, 'approvals.json')
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), file, 1, { durableNotices: true })
    const older = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(0)], holdMs: 30_000 })
    await registry.holdEnded({ tokens: older.requests.map(request => request.token), abandoned: true })
    // Notices the receiver has not taken, leaving room for the waiting ask's two and no ask besides it.
    const state = JSON.parse(readFileSync(file, 'utf8')) as { outbox: unknown[] }
    state.outbox = Array.from({ length: APPROVAL_OUTBOX_COUNT_MAX - 3 }, () => ({ id: crypto.randomUUID(), workspace: root, expiresAt: new Date(Date.now() + APPROVAL_OUTBOX_RETENTION_MS).toISOString(), notice: { token: crypto.randomUUID(), event: 'cancelled', at: new Date().toISOString() } }))
    writeFileSync(file, JSON.stringify(state))

    const fresh = await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(1)], holdMs: 30_000 })
    expect(fresh.evicted).toEqual(older.requests.map(request => request.token))
    expect(registry.pending().map(request => request.token)).toEqual(fresh.requests.map(request => request.token))
    expect(registry.pendingDeliveries()).toContainEqual(expect.objectContaining({ notice: expect.objectContaining({ token: older.requests[0]!.token, event: 'cancelled' }) }))
  })

  it('still refuses when the outbox has no room and no ask is abandoned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-outbox-'))
    const file = join(root, 'approvals.json')
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), file, 1, { durableNotices: true })
    await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(0)], holdMs: 30_000 })
    const state = JSON.parse(readFileSync(file, 'utf8')) as { outbox: unknown[] }
    state.outbox = Array.from({ length: APPROVAL_OUTBOX_COUNT_MAX - 3 }, () => ({ id: crypto.randomUUID(), workspace: root, expiresAt: new Date(Date.now() + APPROVAL_OUTBOX_RETENTION_MS).toISOString(), notice: { token: crypto.randomUUID(), event: 'cancelled', at: new Date().toISOString() } }))
    writeFileSync(file, JSON.stringify(state))

    await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(1)], holdMs: 30_000 })).rejects.toThrow('delivery is full')
  })
})
