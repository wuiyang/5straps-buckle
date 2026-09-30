import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalNotice } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApprovalNoticeSender } from '../common/adapters/approval/webhook-notifier.js'
import { loadConfig, policyPath } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalNotices } from '../common/services/approvals/approval-notices.js'
import { APPROVAL_OUTBOX_BYTES_MAX, APPROVAL_OUTBOX_COUNT_MAX, APPROVAL_OUTBOX_RETENTION_MS, createApprovalRegistry } from '../common/services/approvals/approval-registry.js'

const at = new Date('2026-10-01T12:00:00.000Z').getTime()
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function queue(workspaceRoot?: string) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-outbox-'))
  const file = join(root, 'approvals.json')
  const workspace = workspaceRoot ?? root
  const open = () => createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace }), file, workspace, 1, { durableNotices: true })
  const registry = open()
  const ask = async (count = 1, sessionId: string = randomUUID()) => (await registry.ask({ tool: 'fs_write', sessionId,
    asks: Array.from({ length: count }, (_, i) => ({ kind: 'ask' as const, rule: 'write_scope' as const, subject: `/outside/${i}`, reason: 'outside', offeredScopes: ['once' as const] })),
    call: { arguments: { path: '/outside', content: 'x' }, cwd: root, description: null, complete: true },
  })).requests
  return { root, workspace, file, registry, open, ask }
}
function paused() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

describe('durable approval outcome delivery', () => {
  it('survives a crash after decision before delivery, retries outages, and preserves the signed deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const [ask] = await q.ask(1, 's')
    expect(await q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, 'admin', { consumeNotAfter: at + 30_000 })).toMatchObject({ ok: true })
    const saved = q.registry.pendingDeliveries()
    expect(saved[0]!.notice).toEqual({ token: ask!.token, event: 'answered', at: new Date(at).toISOString(), scope: 'once', consumeNotAfter: new Date(at + 30_000).toISOString() })
    const reopened = q.open()
    const send = vi.fn< (notices: ApprovalNotice[]) => Promise<void> >().mockRejectedValueOnce(new Error('Rings unavailable')).mockResolvedValue(undefined)
    const notices = createApprovalNotices(send, { registry: reopened, retryMs: 50 })
    await notices.flush()
    expect(reopened.pendingDeliveries()).toEqual(saved)
    await vi.advanceTimersByTimeAsync(50)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0]).toEqual([saved[0]!.notice])
    expect(reopened.pendingDeliveries()).toEqual([])
    vi.setSystemTime(at + 30_001)
    expect(reopened.unspent('s')).toEqual([])
    await notices.settle()
  })

  it('records expiry and cancellation atomically, and duplicate skipped notices never extend retention', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const [expires, cancelled] = await q.ask(2)
    await q.registry.enqueueSkippedNotices([{ token: expires!.token, event: 'skipped', at: new Date(at).toISOString(), reason: 'wait_elapsed' }])
    const first = q.registry.pendingDeliveries()[0]!
    vi.setSystemTime(at + 1_000)
    await q.registry.enqueueSkippedNotices([{ token: expires!.token, event: 'skipped', at: new Date(at + 1_000).toISOString(), reason: 'shutdown' }])
    expect(q.registry.pendingDeliveries()[0]).toEqual(first)
    await q.registry.cancel([cancelled!.token])
    vi.setSystemTime(Date.parse(expires!.expiresAt) + 1)
    await q.registry.sweep()
    const reopened = q.open()
    expect(reopened.pending()).toEqual([])
    expect(reopened.pendingDeliveries().map(row => row.notice.event).sort()).toEqual(['cancelled', 'expired'])
    const expiry = reopened.pendingDeliveries().find(row => row.notice.event === 'expired')!
    expect(expiry.notice.at).toBe(new Date(Date.parse(expires!.expiresAt) + 1).toISOString())
    expect(expiry.id).not.toBe(first.id)
    await reopened.acknowledgeDeliveries([first.id])
    expect(reopened.pendingDeliveries()).toHaveLength(2)
  })

  it('acknowledges exact IDs when a terminal outcome replaces an in-flight wait notice', async () => {
    const q = queue()
    const [ask] = await q.ask()
    await q.registry.enqueueSkippedNotices([{ token: ask!.token, event: 'skipped', at: new Date().toISOString(), reason: 'wait_elapsed' }])
    const blocked = paused()
    const sent: ApprovalNotice[][] = []
    const notices = createApprovalNotices(async batch => { sent.push(batch); if (sent.length === 1) await blocked.wait }, { registry: q.registry })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await q.registry.resolve({ token: ask!.token, approved: false, scope: 'once' })
    void notices.flush()
    blocked.release()
    await notices.flush()
    expect(sent.map(batch => batch[0]!.event)).toEqual(['skipped', 'denied'])
    expect(q.registry.pendingDeliveries()).toEqual([])
    await notices.settle()
  })

  it('does not claim a decision succeeded when its atomic state write failed', async () => {
    const q = queue()
    const [ask] = await q.ask(1, 's')
    const backup = `${q.file}.backup`
    await expect(q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, 'admin', {
      expect: () => { renameSync(q.file, backup); mkdirSync(q.file); return true },
    })).rejects.toThrow()
    rmSync(q.file, { recursive: true }); renameSync(backup, q.file)
    expect(q.open().pending()).toHaveLength(1)
    expect(q.open().unspent('s')).toEqual([])
    expect(q.open().pendingDeliveries()).toEqual([])
  })

  it('reserves wait plus largest terminal metadata before admitting an ask, without retaining action contents', async () => {
    const q = queue()
    await q.registry.sweep()
    const state = JSON.parse(readFileSync(q.file, 'utf8')) as { outbox: unknown[] }
    const outcomes = (count: number) => Array.from({ length: count }, () => ({ id: randomUUID(), workspace: q.root, expiresAt: new Date(Date.now() + APPROVAL_OUTBOX_RETENTION_MS).toISOString(), notice: { token: randomUUID(), event: 'cancelled', at: new Date().toISOString() } }))
    state.outbox = outcomes(APPROVAL_OUTBOX_COUNT_MAX - 1)
    writeFileSync(q.file, JSON.stringify(state))
    await expect(q.ask()).rejects.toThrow('delivery is full')
    state.outbox = outcomes(APPROVAL_OUTBOX_COUNT_MAX - 2)
    writeFileSync(q.file, JSON.stringify(state))
    const [ask] = await q.ask()
    await q.registry.enqueueSkippedNotices([{ token: ask!.token, event: 'skipped', at: new Date().toISOString(), reason: 'caller_declined_wait' }])
    expect(await q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, 'admin', { consumeNotAfter: Date.now() + 30_000 })).toMatchObject({ ok: true })
    expect(q.registry.pendingDeliveries()).toHaveLength(APPROVAL_OUTBOX_COUNT_MAX - 1)
    expect(JSON.stringify(q.registry.pendingDeliveries())).not.toContain('/outside')
    expect(q.registry.pendingDeliveries().at(-1)!.notice).toHaveProperty('consumeNotAfter')
  })

  it('enforces the 4MiB metadata limit below the count cap and preserves room for a terminal result', async () => {
    const q = queue()
    await q.registry.sweep()
    const state = JSON.parse(readFileSync(q.file, 'utf8')) as { outbox: Array<{ id: string; workspace: string; expiresAt: string; notice: ApprovalNotice }> }
    state.outbox = Array.from({ length: 1000 }, () => ({ id: randomUUID(), workspace: q.root, expiresAt: new Date(Date.now() + APPROVAL_OUTBOX_RETENTION_MS).toISOString(), notice: { token: randomUUID(), event: 'cancelled', at: new Date().toISOString() } }))
    const first = state.outbox[0]!
    const bytes = Buffer.byteLength(JSON.stringify(state.outbox))
    first.workspace = 'w'.repeat(first.workspace.length + APPROVAL_OUTBOX_BYTES_MAX - bytes + 1)
    writeFileSync(q.file, JSON.stringify(state))
    await expect(q.ask()).rejects.toThrow('delivery is full')
    expect(q.registry.pending()).toEqual([])
    first.workspace = first.workspace.slice(0, -2049)
    writeFileSync(q.file, JSON.stringify(state))
    const [ask] = await q.ask()
    await q.registry.enqueueSkippedNotices([{ token: ask!.token, event: 'skipped', at: new Date().toISOString(), reason: 'caller_declined_wait' }])
    expect(await q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, 'admin', { consumeNotAfter: Date.now() + 30_000 })).toMatchObject({ ok: true })
    const saved = JSON.parse(readFileSync(q.file, 'utf8')) as typeof state
    const used = Buffer.byteLength(JSON.stringify(saved.outbox))
    expect(used).toBeLessThanOrEqual(APPROVAL_OUTBOX_BYTES_MAX)
    expect(used).toBeGreaterThan(APPROVAL_OUTBOX_BYTES_MAX - 2048)
    expect(saved.outbox).toHaveLength(1001)
    expect(saved.outbox.at(-1)!.notice.consumeNotAfter).toBeDefined()
  })

  it('sends batches of at most 100 and close waits only for the current bounded attempt', async () => {
    const q = queue()
    const all = []
    for (let i = 0; i < 3; i++) all.push(...await q.ask(50))
    await q.registry.cancel(all.map(ask => ask.token))
    const blocked = paused()
    const send = vi.fn(async (_batch: ApprovalNotice[]) => { await blocked.wait })
    const notices = createApprovalNotices(send, { registry: q.registry })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const closing = notices.settle()
    blocked.release()
    await closing
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toHaveLength(100)
    expect(q.registry.pendingDeliveries()).toHaveLength(50)
    await notices.settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(q.registry.pendingDeliveries()).toHaveLength(50)
    const remaining: ApprovalNotice[] = []
    const reopened = createApprovalNotices(async batch => { remaining.push(...batch) }, { registry: q.open() })
    await reopened.flush()
    expect(remaining).toHaveLength(50)
    await reopened.settle()
    expect(q.registry.pendingDeliveries()).toEqual([])
  })

  it('expires delivery retention from the original outcome, never from reopening', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const [ask] = await q.ask()
    await q.registry.cancel([ask!.token])
    const original = q.registry.pendingDeliveries()[0]!
    vi.setSystemTime(at + APPROVAL_OUTBOX_RETENTION_MS - 1)
    expect(q.open().pendingDeliveries()).toEqual([original])
    vi.setSystemTime(at + APPROVAL_OUTBOX_RETENTION_MS)
    await q.open().sweep()
    expect(q.registry.pendingDeliveries()).toEqual([])
  })

  it('closes the delivery owner when runtime initialization fails with a network attempt in flight', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue(mkdtempSync(join(tmpdir(), 'buckle-outbox-workspace-')))
    const [ask] = await q.ask()
    await q.registry.cancel([ask!.token])
    const blocked = paused()
    const fetch = vi.fn(async () => { await blocked.wait; return new Response('', { status: 503 }) })
    vi.stubGlobal('fetch', fetch)
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: q.workspace, BUCKLE_STATE_DIR: q.root, BUCKLE_AUTH_TOKEN: 'test-agent', BUCKLE_ADMIN_TOKEN: 'test-admin', BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_WEBHOOK: 'http://rings.test/approvals' })
    writeFileSync(policyPath(config), '{')
    const initializing = createRuntime({ config })
    const rejected = expect(initializing).rejects.toThrow('unreadable or invalid')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    blocked.release()
    await rejected
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(q.registry.pendingDeliveries()).toHaveLength(1)
  })

  it('refuses to acknowledge a non-2xx receiver and creates a fresh sealed envelope for each attempt', async () => {
    const { approvalKey, mintApprovalKey } = await import('@5straps/protocol/envelope')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => { calls.push(String(options.body)); return new Response('', { status: calls.length === 1 ? 503 : 200 }) }))
    const send = createApprovalNoticeSender({ url: 'http://rings.test/approvals', serverId: 'node', workspaceId: 'default', approvalKey: approvalKey(mintApprovalKey()) })
    const notice: ApprovalNotice[] = [{ token: randomUUID(), event: 'expired', at: new Date().toISOString() }]
    await expect(send(notice)).rejects.toThrow('503')
    await expect(send(notice)).resolves.toBeUndefined()
    expect(calls[0]).not.toEqual(calls[1])
  })
})
