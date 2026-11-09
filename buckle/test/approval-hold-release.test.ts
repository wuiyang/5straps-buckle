import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryNonceClaims } from '../common/adapters/approval/memory-nonce-claims.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, type ApprovalAskInput, type ApprovalService } from '../common/services/approvals/approval-service.js'
import { heldAskName } from '../common/services/approvals/full-ask.js'
import { createExecutingMark, executingMarks } from '../common/services/workspaces/active-work.js'
import type { ApprovalBackend } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { UNHEARD_DECISIONS } from './support/decision-audit.js'

// A call holds its session, and names its ask, in its runtime's executing mark from before its ask is recorded to the end
// of its wait, which keeps that session from ending at idle and the ask from lapsing while another process holds it. A
// hold left behind on any way out would keep the session for the life of the process, so each way out is pinned here:
// as many holds end as began, and no mark is left.

const roots: string[] = []
const services: ApprovalService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A ledger and its service, with a terminal that keeps asking until core stops it, and each hold counted. */
function setUp(graceMs: number | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-hold-release-'))
  roots.push(root)
  const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w' }), join(root, 'approvals.json'), 15_000)
  const terminal: ApprovalBackend = {
    open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
    submit: (_asks, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ kind: 'accepted', refs: [] }), { once: true })),
    async notify() {},
    close: async () => undefined,
  }
  const marks = join(root, 'active-work')
  const executing = createExecutingMark({ directory: marks, workspaceId: 'w', instance: 'here' })
  const holds = { begun: 0, ended: 0 }
  const service = createApprovalService({
    registry, workspaceId: 'w', serverId: 'node-1', graceMs, hold: async () => 'grace', terminal, nonces: createMemoryNonceClaims(), decisionAudit: UNHEARD_DECISIONS,
    holding: ({ session, ask }) => {
      holds.begun++
      const run = executing.begin(session, ask)
      return { end() { holds.ended++; run.end() } }
    },
  })
  services.push(service)
  /** Every hold that began has ended, and no mark is left. */
  const released = () => {
    expect(holds.begun).toBeGreaterThan(0)
    expect(holds.ended).toBe(holds.begun)
    expect(executingMarks({ directory: marks })).toEqual([])
  }
  return { registry, service, holds, marks, released }
}

const ASK = { kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject: '/outside/a', reason: 'outside the workspace', offeredScopes: ['once' as const] }
const CALL = { arguments: {}, cwd: '/', description: null, complete: true as const }
const call = (extra: Partial<ApprovalAskInput> = {}): ApprovalAskInput => ({ sessionId: 's', requestId: 'r-1', tool: 'fs_write', call: CALL, asks: [ASK], ...extra })

describe('the hold a call takes while it waits for a person', () => {
  it('names its session and its ask while it waits, and ends as a person approves the ask', async () => {
    const { registry, service, marks, released } = setUp()
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    expect(executingMarks({ directory: marks })).toEqual([{ instance: 'here', sessions: [{ sessionId: 's' }], asks: [heldAskName({ sessionId: 's', requestId: 'r-1' })] }])

    const [token] = registry.pending().map(request => request.token)
    expect(await service.answer({ decision: { token: token!, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(await waiting).toMatchObject({ settled: true })
    released()
  })

  it('ends as a person denies the ask', async () => {
    const { registry, service, released } = setUp()
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    const [token] = registry.pending().map(request => request.token)
    expect(await service.answer({ decision: { token: token!, approved: false, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(await waiting).toMatchObject({ settled: true })
    released()
  })

  it('ends as its wait elapses, the ask still waiting', async () => {
    const { registry, service, released } = setUp()
    expect(await service.request(call({ wait: { mode: 'finite', ms: 50 } }))).toMatchObject({ settled: false })
    expect(registry.pending()).toHaveLength(1)
    released()
  })

  it('ends as its transport drops, the ask still waiting', async () => {
    const { registry, service, holds, released } = setUp()
    const drop = new AbortController()
    const waiting = service.request(call({ signal: drop.signal }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    expect(holds.ended).toBe(0)
    drop.abort()
    await expect(waiting).rejects.toBeDefined()
    expect(registry.pending()).toHaveLength(1)
    released()
  })

  it('ends as a re-send with the same requestId takes its wait over, and the re-send\'s as its own wait ends', async () => {
    const { registry, service, holds, released } = setUp()
    const first = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    const second = service.request(call({ wait: { mode: 'finite', ms: 50 } }))
    expect(await first).toMatchObject({ superseded: true })
    expect(await second).toMatchObject({ settled: false })
    expect(holds.begun).toBe(2)
    released()
  })

  it('ends as its caller cancels, which withdraws the ask', async () => {
    const { registry, service, released } = setUp()
    const cancel = new AbortController()
    const waiting = service.request(call({ signal: cancel.signal, isCancel: () => true }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    cancel.abort()
    await expect(waiting).rejects.toBeDefined()
    expect(registry.pending()).toEqual([])
    released()
  })

  it('ends as the service closes, the call answering that it is still waiting', async () => {
    const { registry, service, released } = setUp()
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    await service.close()
    expect(await waiting).toMatchObject({ settled: false })
    released()
  })

  it('ends at once for a call that would not wait, and for a re-send joined to an ask already denied', async () => {
    const { registry, service, released } = setUp()
    expect(await service.request(call({ wait: { mode: 'none' } }))).toMatchObject({ settled: false })
    released()
    const [token] = registry.pending().map(request => request.token)
    expect(await service.answer({ decision: { token: token!, approved: false, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(await service.request(call())).toMatchObject({ settled: true, approvals: [] })
    released()
  })
})
