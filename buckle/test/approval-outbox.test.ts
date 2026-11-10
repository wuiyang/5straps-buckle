import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApprovalNotice } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApprovalNoticeSender } from '../common/adapters/approval/webhook-notifier.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalNotices, type ApprovalNotices } from '../common/services/approvals/approval-notices.js'
import { APPROVAL_OUTBOX_BYTES_MAX, APPROVAL_OUTBOX_COUNT_MAX, APPROVAL_OUTBOX_RETENTION_MS, createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { logger } from '../common/runtime/log.js'
import { NoticeRefusedError } from '../common/domain/approval/notice-refused.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

const at = new Date('2026-10-01T12:00:00.000Z').getTime()
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function queue(workspaceKey?: string, stateDirectory?: string) {
  const root = stateDirectory ?? mkdtempSync(join(tmpdir(), 'buckle-outbox-'))
  const file = join(root, 'approvals.json')
  const workspace = workspaceKey ?? root
  const open = () => createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace }), file, 1, { durableNotices: true })
  const registry = open()
  const ask = async (count = 1, sessionId: string = randomUUID()) => (await registry.ask({ tool: 'fs_write', sessionId,
    asks: Array.from({ length: count }, (_, i) => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject: `/outside/${i}`, reason: 'outside', offeredScopes: ['once' as const] })),
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
    expect(await q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, SOURCES.cli, { consumeNotAfter: at + 30_000 })).toMatchObject({ ok: true })
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

  it('records a skip for no response and a cancellation atomically, and duplicate wait notices never extend retention', async () => {
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
    expect(reopened.pendingDeliveries().map(row => row.notice.event).sort()).toEqual(['cancelled', 'skipped'])
    const expiry = reopened.pendingDeliveries().find(row => row.notice.event === 'skipped')!
    expect(expiry.notice).toMatchObject({ token: expires!.token, event: 'skipped', reason: 'no_response' })
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
    await q.registry.resolve({ token: ask!.token, approved: false, scope: 'once' }, SOURCES.cli)
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
    await expect(q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, SOURCES.cli, {
      challenge: { digest: 'shown', shown: () => { renameSync(q.file, backup); mkdirSync(q.file); return ['shown'] } },
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
    expect(await q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, SOURCES.cli, { consumeNotAfter: Date.now() + 30_000 })).toMatchObject({ ok: true })
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
    expect(await q.registry.resolve({ token: ask!.token, approved: true, scope: 'once' }, SOURCES.cli, { consumeNotAfter: Date.now() + 30_000 })).toMatchObject({ ok: true })
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

  // A runtime's config with one cancelled ask's notice queued for its webhook, and a fetch that holds each attempt
  // until released and then answers 503.
  async function queuedNoticeRuntime(environment: NodeJS.ProcessEnv = {}) {
    const workspace = mkdtempSync(join(tmpdir(), 'buckle-outbox-workspace-'))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-outbox-')), BUCKLE_AUTH_TOKEN: 'test-agent', BUCKLE_ADMIN_TOKEN: 'test-admin', BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_WEBHOOK: 'http://rings.test/approvals', ...environment })
    // The queue the runtime takes over lives in the workspace's own records folder, under its id.
    mkdirSync(config.stateDirectory, { recursive: true })
    const q = queue(config.workspaceId, config.stateDirectory)
    const [ask] = await q.ask()
    await q.registry.cancel([ask!.token])
    const blocked = paused()
    const fetch = vi.fn(async () => { await blocked.wait; return new Response('', { status: 503 }) })
    vi.stubGlobal('fetch', fetch)
    return { config, q, fetch, blocked }
  }

  it('closes the delivery owner when runtime initialization fails with a network attempt in flight', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    // A skill path that is a file fails the open at loading skills, which comes after the delivery owner starts sending.
    const notADirectory = join(mkdtempSync(join(tmpdir(), 'buckle-outbox-skills-')), 'SKILL.md')
    writeFileSync(notADirectory, '')
    const { config, q, fetch, blocked } = await queuedNoticeRuntime({ BUCKLE_SKILLS_DIRS: notADirectory })
    const rejected = expect(createRuntime({ config })).rejects.toThrow('Skill path is not a directory')
    await vi.waitFor(() => expect(fetch, 'a delivery attempt starts before the open fails').toHaveBeenCalledTimes(1))
    blocked.release()
    await rejected
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(q.registry.pendingDeliveries()).toHaveLength(1)
  })

  it('starts no delivery when runtime initialization fails reading the workspace settings', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const { config, q, fetch } = await queuedNoticeRuntime()
    const file = settingsPath(config.nodeStateDirectory!, config.workspaceId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{')
    await expect(createRuntime({ config })).rejects.toThrow('unreadable or invalid')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetch).not.toHaveBeenCalled()
    expect(q.registry.pendingDeliveries()).toHaveLength(1)
  })

  it('refuses to acknowledge a non-2xx receiver and creates a fresh sealed envelope for each attempt', async () => {
    const { approvalKey, mintApprovalKey } = await import('@5straps/protocol/envelope')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => { calls.push(String(options.body)); return new Response('', { status: calls.length === 1 ? 503 : 200 }) }))
    const send = createApprovalNoticeSender({ url: 'http://rings.test/approvals', serverId: 'node', workspaceId: 'default', approvalKey: approvalKey(mintApprovalKey()) })
    const notice: ApprovalNotice[] = [{ token: randomUUID(), event: 'skipped', at: new Date().toISOString(), reason: 'no_response' }]
    await expect(send(notice)).rejects.toThrow('503')
    await expect(send(notice)).resolves.toBeUndefined()
    expect(calls[0]).not.toEqual(calls[1])
  })

  it.each([400, 413, 422])('names an HTTP %d answer a refusal of the notices themselves', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    const send = createApprovalNoticeSender({ url: 'http://rings.test/approvals', serverId: 'node', workspaceId: 'default' })
    const notice: ApprovalNotice[] = [{ token: randomUUID(), event: 'skipped', at: new Date().toISOString(), reason: 'no_response' }]
    const refusal = await send(notice).then(() => undefined, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(NoticeRefusedError)
    expect(refusal).toMatchObject({ status, message: `Approval lifecycle webhook returned HTTP ${status}` })
  })

  it.each([401, 403, 404, 429, 500, 503])('leaves an HTTP %d answer a failure of the receiver or the link, not of the notices', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    const send = createApprovalNoticeSender({ url: 'http://rings.test/approvals', serverId: 'node', workspaceId: 'default' })
    const refusal = await send([{ token: randomUUID(), event: 'cancelled', at: new Date().toISOString() }]).then(() => undefined, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal).not.toBeInstanceOf(NoticeRefusedError)
  })
})

// Review M2 of the continuation review: an ask without the notify flag (asked before the webhook was configured, by
// a process without it, or before 3a66f2b) reserved no room, so its expiry at the outbox cap threw inside every
// update, acknowledgement included, and nothing drained or decided until the oldest entry aged out.
describe('an ask\'s end is recorded whatever the outbox holds', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const entry = (q: ReturnType<typeof queue>, expiresAt: number, notify: boolean) => ({
    request: { token: randomUUID(), rule: 'write_scope', subject: '/outside/x', reason: 'outside', tool: 'fs_write', offeredScopes: ['once'], expiresAt: iso(expiresAt) },
    sessionId: 's', workspace: q.workspace, ...(notify ? { notify: true } : {}),
  })
  const outcomes = (q: ReturnType<typeof queue>, count: number) => Array.from({ length: count }, () => ({ id: randomUUID(), workspace: q.workspace, notice: { token: randomUUID(), event: 'cancelled', at: iso(Date.now() - 60_000) }, expiresAt: iso(Date.now() + APPROVAL_OUTBOX_RETENTION_MS - 60_000) }))
  /** One waiting ask holding its reservation, one unreserved ask that has just expired, and the outbox at its cap. */
  function atCap(q: ReturnType<typeof queue>) {
    const live = entry(q, Date.now() + 3_600_000, true)
    const legacy = entry(q, Date.now() - 1_000, false)
    writeFileSync(q.file, JSON.stringify({ version: 1, pending: [live, legacy], once: [], resolved: [], outbox: outcomes(q, APPROVAL_OUTBOX_COUNT_MAX - 2) }))
    return { live, legacy }
  }

  it.each<[string, (registry: ReturnType<ReturnType<typeof queue>['open']>, live: { request: { token: string } }) => Promise<unknown>]>([
    ['acknowledge', registry => registry.acknowledgeDeliveries(registry.pendingDeliveries().slice(0, 100).map(item => item.id))],
    ['sweep', registry => registry.sweep()],
    ['cancel', registry => registry.cancel(['none'])],
    ['resolve', (registry, live) => registry.resolve({ token: live.request.token, approved: false, scope: 'once' }, SOURCES.cli)],
  ])('lets %s commit while an unreserved ask expires at the cap, and records that expiry', async (_, act) => {
    const q = queue()
    const { live, legacy } = atCap(q)
    const registry = q.open()
    await act(registry, live)
    expect(registry.pendingDeliveries().some(item => item.notice.token === legacy.request.token && item.notice.event === 'skipped' && item.notice.reason === 'no_response')).toBe(true)
  })

  it('acknowledges, sweeps, cancels, resolves and asks again in turn once the receiver drains the head', async () => {
    const q = queue()
    const { live, legacy } = atCap(q)
    const registry = q.open()
    await registry.acknowledgeDeliveries(registry.pendingDeliveries().slice(0, 100).map(item => item.id))
    await registry.sweep()
    expect(await registry.cancel(['none'])).toEqual([])
    expect(await registry.resolve({ token: live.request.token, approved: false, scope: 'once' }, SOURCES.cli)).toMatchObject({ ok: true })
    expect(await q.ask()).toHaveLength(1)
    expect(registry.pendingDeliveries().map(item => item.notice)).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: legacy.request.token, event: 'skipped', reason: 'no_response' }),
      expect.objectContaining({ token: live.request.token, event: 'denied' }),
    ]))
  })

  // Slice 7 review, notes: past the limits each kept end warned on its own, so one sweep of 500 unreserved asks wrote
  // 499 identical warnings. The update that keeps them warns once.
  it('warns once for a sweep that keeps many unreserved ends past the limits, not once for each', async () => {
    const q = queue()
    const legacy = Array.from({ length: 20 }, () => entry(q, Date.now() - 1_000, false))
    writeFileSync(q.file, JSON.stringify({ version: 1, pending: legacy, once: [], resolved: [], outbox: outcomes(q, APPROVAL_OUTBOX_COUNT_MAX - 2) }))
    const registry = q.open()
    const warn = vi.spyOn(logger, 'warn')
    try {
      await registry.sweep()
      expect(registry.pendingDeliveries().filter(item => item.notice.reason === 'no_response')).toHaveLength(20)
      expect(warn.mock.calls.filter(([message]) => message.startsWith('Approval outcome delivery is past its limits')))
        .toEqual([[expect.any(String), { entries: APPROVAL_OUTBOX_COUNT_MAX - 2 + 20, added: 20, events: ['skipped'] }]])
    } finally {
      warn.mockRestore()
    }
  })

  it('still refuses a new ask while reserved asks hold the outbox at its maximum (control)', async () => {
    const q = queue()
    const live = entry(q, Date.now() + 3_600_000, true)
    writeFileSync(q.file, JSON.stringify({ version: 1, pending: [live], once: [], resolved: [], outbox: outcomes(q, APPROVAL_OUTBOX_COUNT_MAX - 2) }))
    await expect(q.ask()).rejects.toThrow('delivery is full')
    await q.registry.sweep()
    expect(await q.registry.resolve({ token: live.request.token, approved: false, scope: 'once' }, SOURCES.cli)).toMatchObject({ ok: true })
    expect(q.registry.pendingDeliveries()).toHaveLength(APPROVAL_OUTBOX_COUNT_MAX - 1)
  })

  it('reserves room for a waiting ask without the flag once a durable registry admits asks', async () => {
    const q = queue()
    const unflagged = entry(q, Date.now() + 3_600_000, false)
    writeFileSync(q.file, JSON.stringify({ version: 1, pending: [unflagged], once: [], resolved: [], outbox: outcomes(q, APPROVAL_OUTBOX_COUNT_MAX - 3) }))
    await expect(q.ask()).rejects.toThrow('delivery is full')
    expect(await q.registry.cancel([unflagged.request.token])).toEqual([unflagged.request.token])
    expect(await q.ask()).toHaveLength(1)
  })
})

// Review L6 of the continuation review: every index write signalled the sender, which cleared its retry timer, so
// twenty updates that queued nothing made twenty attempts in a second while the receiver failed.
describe('the outcome sender keeps its retry delay while the receiver fails', () => {
  it('starts no attempt for updates that queue nothing, and holds a newly queued outcome for the retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-outbox-retry-'))
    let notices: ApprovalNotices | undefined
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), 1, { durableNotices: true, onNoticeQueued: () => { void notices?.flush() } })
    const attempts: number[] = []
    notices = createApprovalNotices(async () => { attempts.push(Date.now()); throw new Error('HTTP 503') }, { registry, retryMs: 2_000 })
    const asked = async () => (await registry.ask({ tool: 'fs_write', sessionId: 's', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }], call: { arguments: { path: '/outside', content: 'x' }, cwd: root, description: null, complete: true } })).requests
    try {
      await registry.cancel((await asked()).map(request => request.token))
      await vi.waitFor(() => expect(attempts).toHaveLength(1))
      for (let index = 0; index < 20; index++) {
        await registry.cancel(['none'])
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      await registry.cancel((await asked()).map(request => request.token))
      expect(attempts).toHaveLength(1)
      expect(registry.pendingDeliveries()).toHaveLength(2)
      await vi.waitFor(() => expect(attempts).toHaveLength(2), { timeout: 4_000 })
      expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1_900)
    } finally {
      await notices.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// A receiver on an older protocol refuses a whole batch for one notice it cannot read, such as the skipped notice with
// the reason no_response (APPROVAL-36). The others in the batch must still arrive, and the refused one must wait for a
// receiver that takes it, for as long as the outbox keeps it.
describe('a receiver that refuses one notice', () => {
  const PAUSE_MS = 5 * 60_000
  const refusing = (refused: Set<string>, delivered: string[] = []) => vi.fn(async (batch: ApprovalNotice[]) => {
    if (batch.some(notice => refused.has(notice.token))) throw new NoticeRefusedError(400)
    delivered.push(...batch.map(notice => notice.token))
  })
  async function answered(q: ReturnType<typeof queue>, count: number) {
    const asks = await q.ask(count)
    for (const ask of asks) await q.registry.resolve({ token: ask.token, approved: true, scope: 'once' }, SOURCES.cli)
    return asks.map(ask => ask.token)
  }

  it('delivers the other notices, holds the refused one, and sends it again once the pause has passed', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const [first, poison, last] = await answered(q, 3)
    const refused = new Set([poison!])
    const delivered: string[] = []
    const send = refusing(refused, delivered)
    const notices = createApprovalNotices(send, { registry: q.registry, retryMs: 50 })
    await notices.flush()
    expect(delivered.sort()).toEqual([first!, last!].sort())
    expect(q.registry.pendingDeliveries().map(row => row.notice.token)).toEqual([poison])
    const calls = send.mock.calls.length
    await vi.advanceTimersByTimeAsync(PAUSE_MS - 1_000)
    expect(send.mock.calls.length, 'the refused notice is not sent again during the pause').toBe(calls)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(send.mock.calls.at(-1)![0].map(notice => notice.token)).toEqual([poison])
    expect(q.registry.pendingDeliveries()).toHaveLength(1)
    refused.clear()
    await vi.advanceTimersByTimeAsync(PAUSE_MS + 1_000)
    expect(delivered).toContain(poison)
    expect(q.registry.pendingDeliveries()).toEqual([])
    await notices.settle()
  })

  it('does not let a held notice delay one that arrives after it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const [poison] = await answered(q, 1)
    const delivered: string[] = []
    const send = refusing(new Set([poison!]), delivered)
    const notices = createApprovalNotices(send, { registry: q.registry, retryMs: 50 })
    await notices.flush()
    expect(q.registry.pendingDeliveries()).toHaveLength(1)
    const [later] = await answered(q, 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(delivered).toEqual([later])
    expect(send.mock.calls.at(-1)![0].map(notice => notice.token)).toEqual([later])
    expect(q.registry.pendingDeliveries().map(row => row.notice.token)).toEqual([poison])
    await notices.settle()
  })

  it('asks a receiver that refuses everything once per notice, then leaves it alone for the pause', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const tokens = await answered(q, 4)
    const send = refusing(new Set(tokens))
    const notices = createApprovalNotices(send, { registry: q.registry, retryMs: 50 })
    await notices.flush()
    expect(q.registry.pendingDeliveries()).toHaveLength(4)
    const calls = send.mock.calls.length
    expect(calls).toBeLessThanOrEqual(2 * tokens.length)
    await vi.advanceTimersByTimeAsync(PAUSE_MS - 1_000)
    expect(send.mock.calls.length).toBe(calls)
    await notices.settle()
  })

  it('does not split a batch an outage failed: nothing was refused, so all of it waits for the retry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    await answered(q, 3)
    const send = vi.fn(async (_batch: ApprovalNotice[]) => { throw new Error('connect ECONNREFUSED') })
    const notices = createApprovalNotices(send, { registry: q.registry, retryMs: 50 })
    await notices.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toHaveLength(3)
    expect(q.registry.pendingDeliveries()).toHaveLength(3)
    await notices.settle()
  })

  it('keeps a refused notice across a restart and sends it again at once, then holds it for the pause', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at)
    const q = queue()
    const [, poison] = await answered(q, 2)
    const before = createApprovalNotices(refusing(new Set([poison!])), { registry: q.registry, retryMs: 50 })
    await before.settle()
    expect(q.registry.pendingDeliveries().map(row => row.notice.token)).toEqual([poison])
    const delivered: string[] = []
    const after = createApprovalNotices(refusing(new Set(), delivered), { registry: q.open(), retryMs: 50 })
    await after.flush()
    expect(delivered).toEqual([poison])
    expect(q.registry.pendingDeliveries()).toEqual([])
    await after.settle()
  })
})
