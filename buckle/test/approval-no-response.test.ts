import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ApprovalNoticeSchema } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { describeExpiry } from '../common/domain/approval-deadline.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { logger } from '../common/runtime/log.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { fixedInteraction, headlessGrace } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// APPROVAL-36 (owner, 2026-11-10): an ask nobody answered before it ran out, at its ten-minute lapse or its stated expiry,
// is skipped with the reason no_response, never denied. The ledger keeps that end as long as it keeps an answer, so every
// process reads why the ask left, a late answer is told, and the webhook hears it once, as the end that replaces any wait
// notice before it.

const MINUTE = 60_000
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ASK = { kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject: '/outside/a.md', reason: 'outside', offeredScopes: ['once' as const, 'session' as const] }
const CALL = { arguments: { path: '/outside/a.md' }, cwd: '/w', description: null, effects: [], complete: true as const }

function ledger(durableNotices = false) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-no-response-'))
  roots.push(root)
  const open = () => createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 15_000, { durableNotices })
  return { root, file: join(root, 'approvals.json'), registry: open(), open }
}

async function ranOut(registry: ReturnType<typeof ledger>['registry']): Promise<string> {
  const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r-1', asks: [ASK], call: CALL })).requests
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(request!.expiresAt) + 1_000)
  return request!.token
}

describe('an ask nobody answered before it ran out', () => {
  it('reads as skipped, no response, to every process, the one that did not drop it included', async () => {
    const { registry, open } = ledger()
    const token = await ranOut(registry)
    const other = open()
    await other.sweep()
    expect(registry.pending()).toEqual([])
    expect(registry.departures([token]).get(token)).toEqual({ type: 'skipped', reason: 'no_response' })
    expect(other.departures([token]).get(token)).toEqual({ type: 'skipped', reason: 'no_response' })
    expect(registry.wasDenied([token])).toBe(false)
  })

  it('tells a late answer it was skipped with no response, from any process, and records nothing', async () => {
    const { registry, open, root } = ledger()
    const token = await ranOut(registry)
    const refusal = { code: 'ask_closed', reason: 'This ask was skipped: no response. Nobody answered it before it ran out, so its call did not run; the call sent again asks afresh' }
    expect(await registry.resolve({ token, approved: true, scope: 'once' }, SOURCES.cli)).toMatchObject({ ok: false, code: refusal.code, reason: refusal.reason })
    expect(await open().resolve({ token, approved: false, scope: 'once' }, SOURCES.terminal)).toMatchObject({ ok: false, code: refusal.code, reason: refusal.reason })
    expect(registry.wasDenied([token])).toBe(false)
    expect(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }).list()).toEqual([])
    // Kept as long as an answer is kept, then unknown as any token.
    vi.setSystemTime(Date.now() + 11 * MINUTE)
    expect(await registry.resolve({ token, approved: true, scope: 'once' }, SOURCES.cli)).toMatchObject({ ok: false, code: 'unknown_ask', reason: 'Approval token is unknown or no longer waiting' })
    expect(open().departures([token]).size).toBe(0)
  })

  it('queues one end for the webhook, skipped with the reason no_response, which replaces a wait notice and is never replaced by one', async () => {
    const { registry } = ledger(true)
    const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r-1', asks: [ASK], call: CALL })).requests
    await registry.enqueueSkippedNotices([{ token: request!.token, event: 'skipped', at: new Date().toISOString(), reason: 'wait_elapsed' }])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(request!.expiresAt) + 1_000)
    await registry.sweep()
    expect(registry.pendingDeliveries().map(entry => entry.notice)).toEqual([{ token: request!.token, event: 'skipped', at: new Date(Date.now()).toISOString(), reason: 'no_response' }])
    await registry.enqueueSkippedNotices([{ token: request!.token, event: 'skipped', at: new Date().toISOString(), reason: 'shutdown' }])
    expect(registry.pendingDeliveries().map(entry => entry.notice.reason)).toEqual(['no_response'])
  })

  it('is never queued by a route: only the ledger ends an ask for no response', async () => {
    const { registry } = ledger(true)
    const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r-1', asks: [ASK], call: CALL })).requests
    await expect(registry.enqueueSkippedNotices([{ token: request!.token, event: 'skipped', at: new Date().toISOString(), reason: 'no_response' }])).rejects.toThrow('Only registry transitions enqueue terminal approval outcomes')
    expect(registry.pendingDeliveries()).toEqual([])
    expect(registry.pending()).toHaveLength(1)
  })

  // Finding 2 of the APPROVAL-36/37 review: a build from before APPROVAL-36 shares the state directory after a rollback, or
  // as a serve still running beside a newer command, and its schema refuses the reason no_response, which would leave the
  // whole file unread.
  it('keeps its end in the outbox in the shape a build from before the ruling reads, and sends it as skipped, no response', async () => {
    const { registry, file } = ledger(true)
    const token = await ranOut(registry)
    await registry.sweep()
    const before = z.object({ outbox: z.array(z.object({ notice: ApprovalNoticeSchema.extend({ reason: z.enum(['caller_declined_wait', 'no_approver', 'wait_elapsed', 'shutdown']).optional() }) })) })
    const saved = before.parse(JSON.parse(readFileSync(file, 'utf8')))
    expect(saved.outbox.map(entry => entry.notice)).toEqual([{ token, event: 'expired', at: new Date(Date.now()).toISOString() }])
    expect(registry.pendingDeliveries().map(entry => entry.notice)).toEqual([{ token, event: 'skipped', at: new Date(Date.now()).toISOString(), reason: 'no_response' }])
  })

  it('sends an end an older node queued as expired as skipped, no response', async () => {
    const { file, open } = ledger(true)
    const legacy = { id: randomUUID(), workspace: 'w-1', notice: { token: 't-old', event: 'expired', at: new Date().toISOString() }, expiresAt: new Date(Date.now() + 60 * MINUTE).toISOString() }
    writeFileSync(file, JSON.stringify({ version: 1, pending: [], once: [], resolved: [], outbox: [legacy], ended: [] }))
    const registry = open()
    expect(registry.pendingDeliveries().map(entry => entry.notice)).toEqual([{ token: 't-old', event: 'skipped', at: legacy.notice.at, reason: 'no_response' }])
    await registry.sweep()
    expect(JSON.parse(readFileSync(file, 'utf8')).outbox).toHaveLength(1)
  })

  it('reads its deadline, once passed, as skipped with no response', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'))
    expect(describeExpiry('2026-11-10T09:59:00.000Z')).toBe('skipped: no response (2026-11-10T09:59:00.000Z)')
    expect(describeExpiry('2026-11-10T10:09:58.000Z')).toBe('expires in 9m 58s (2026-11-10T10:09:58.000Z)')
  })

  it('is logged once, by the process that dropped it, naming the reason and never the subject', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-no-response-runtime-'))
    roots.push(root)
    for (const directory of ['workspace', 'workspace/one']) mkdirSync(join(root, directory))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '50' })
    const runtime = await createRuntime({ config, interaction: fixedInteraction(headlessGrace) })
    try {
      expect(await runtime.invoke({ sessionId: 's', request: { requestId: 'w-1', tool: 'fs_write', args: { path: 'one/a.md', content: 'a' }, approvalTokens: [] } })).toMatchObject({ outcome: 'approval_required' })
      const [asked] = runtime.approvalService.pending()
      const info = vi.spyOn(logger, 'info')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(asked!.expiresAt) + 1_000)
      await runtime.approvals.sweep()
      await runtime.approvals.sweep()
      const lines = info.mock.calls.filter(([message]) => String(message).startsWith('Skipped approvals nobody answered'))
      expect(lines).toEqual([['Skipped approvals nobody answered before they ran out', { reason: 'no_response', asks: 1, workspaceId: runtime.workspaceId }]])
      expect(JSON.stringify(lines)).not.toContain('one/a.md')
    } finally {
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  })
})
