import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeRequest } from '@5straps/protocol'
import { APPROVAL_NO_DEADLINE } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry, MAX_PENDING_PER_SESSION, MAX_PENDING_PER_WORKSPACE } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'

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

afterEach(() => { vi.useRealTimers() })

/** Moves the wall clock the asks' expiries are read on, and nothing else, so the node's own timers keep running. */
function clockAt(time: number): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(time)
}

function queue() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-queue-'))
  return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root, null)
}

const outside = (index: number) => ({ kind: 'ask' as const, rule: 'write_scope' as const, subject: `/outside/${index}`, reason: 'outside', offeredScopes: ['once' as const] })

function results(runtime: BuckleRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.requestId === requestId)
}

describe('a call whose caller left while it waited for a person', () => {
  it('answers CALLER_LEFT, audits that it did not run under that code, and keeps its ask', async () => {
    const { runtime } = await node()
    const leaving = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('left-1'), signal: leaving.signal })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    leaving.abort()

    expect(await waiting).toMatchObject({ outcome: 'error', error: { code: 'CALLER_LEFT', retryable: true } })
    expect(results(runtime, 'left-1')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'CALLER_LEFT' })])
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
    expect(results(runtime, 'cancelled-1')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'CALLER_CANCELLED' })])
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
    expect(await runtime.approvalService.answer({ decision: { token: token!, approved: true, scope: 'once' }, authority: 'admin' })).toMatchObject({ ok: true })
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
    const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
    const other = createApprovalRegistry(grants, join(root, 'approvals.json'), 'other', null)
    const own = createApprovalRegistry(grants, join(root, 'approvals.json'), 'own', null)
    const older = await other.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(0)], holdMs: 30_000 })
    await other.holdEnded({ tokens: older.requests.map(request => request.token), abandoned: true })
    const asked = await own.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(index)), holdMs: 30_000 })
    await own.holdEnded({ tokens: asked.requests.map(request => request.token), abandoned: true })

    expect((await own.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(MAX_PENDING_PER_SESSION)], holdMs: 30_000 })).evicted).toEqual([asked.requests[0]!.token])
    expect(other.pending().map(request => request.token)).toEqual(older.requests.map(request => request.token))
  })

  it('still refuses a session full of asks a caller holds or was answered about, as before', async () => {
    const registry = queue()
    await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => outside(index)), holdMs: 30_000 })
    await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: [outside(MAX_PENDING_PER_SESSION)], holdMs: 30_000 })).rejects.toThrow(/limit 50/)
  })
})

describe('an ask at wait 0', () => {
  it('states no deadline, and lapses ten minutes after its hold ended', async () => {
    const start = Date.now()
    const { runtime } = await node('0')
    const response = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-1'), approvalWait: { mode: 'finite', ms: 50 } })
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
    const first = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-2'), approvalWait: { mode: 'none' } })
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
    await runtime.invoke({ sessionId: 'chat-1', request: write('zero-3'), approvalWait: { mode: 'none' } })
    clockAt(start + 9 * MINUTE)
    const again = await runtime.invoke({ sessionId: 'chat-1', request: write('zero-3'), approvalWait: { mode: 'none' } })
    expect(again).toMatchObject({ outcome: 'approval_required' })

    clockAt(start + 15 * MINUTE)
    expect(runtime.approvalService.pending()).toHaveLength(1)
    clockAt(start + 20 * MINUTE)
    expect(runtime.approvalService.pending()).toEqual([])
    await runtime.history.close()
  })

  it('held until decided, lapses ten minutes after its caller left', async () => {
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

  // A script's call (owner decision D82) waits no later than its script's deadline: held until answered by the node, its
  // hold still ends, and its ask lapses ten minutes after, whether the deadline left it some wait or none.
  it.each([['some wait', 50], ['no wait', -1]] as const)('held until answered within a script\'s deadline, with %s left, lapses ten minutes after', async (_, leftMs) => {
    const start = Date.now()
    const registry = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: null, interaction: fixedInteraction() })
    const waited = await service.request({ sessionId: 's', requestId: `script-${leftMs}`, tool: 'fs_write', asks: [outside(1)], holdUntil: performance.now() + leftMs })
    expect(waited.settled).toBe(false)
    clockAt(start + 9 * MINUTE)
    expect(registry.pending()).toHaveLength(1)
    clockAt(start + 11 * MINUTE)
    expect(registry.pending()).toEqual([])
    await service.close()
  })
})
