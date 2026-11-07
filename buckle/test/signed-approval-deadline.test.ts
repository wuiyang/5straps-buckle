import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalNotice } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import type { PermissionOutcome } from '../common/domain/permission/engine.js'
import { createApprovalNotices } from '../common/services/approvals/approval-notices.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const prompt = { kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject: '/outside', reason: 'Write outside', offeredScopes: ['once'] as const }
const DECIDER = `key:SHA256:${'A'.repeat(43)}`

async function queue() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-signed-deadline-'))
  roots.push(root)
  const file = join(root, 'approvals.json')
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  const registry = createApprovalRegistry(grants, file, root)
  const token = (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r', asks: [{ ...prompt, offeredScopes: [...prompt.offeredScopes] }], call: { arguments: { path: '/outside/notes.md', content: 'hello' }, cwd: '/workspace', description: 'Write notes', effects: ['write /outside/notes.md'], complete: true } })).requests[0]!.token
  const decision = { token, approved: true, scope: 'once' as const }
  const evaluate = (extra: Partial<Parameters<typeof registry.evaluate>[0]> = {}) => registry.evaluate({ tokens: [token], sessionId: 's', tool: 'fs_write', check: subjects => subjects.length ? { kind: 'allow', allowedBy: ['once'] } : { kind: 'ask', asks: [{ ...prompt, offeredScopes: [...prompt.offeredScopes] }] }, ...extra })
  return { file, grants, registry, token, decision, evaluate }
}

describe('signed once proof consumption deadline', () => {
  it.each([59_999, 60_000, 60_001])('admits the exact call only before the proof deadline, at elapsed %sms', async (elapsed) => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, decision, evaluate } = await queue()
    expect(await registry.resolve(decision, 'admin', { decidedBy: DECIDER, consumeNotAfter: now + 60_000 })).toMatchObject({ ok: true })
    now += elapsed
    const admit = vi.fn(() => true)
    const spent = vi.fn()
    const outcome = await evaluate({ admit, spent })
    expect(outcome.kind).toBe(elapsed < 60_000 ? 'allow' : 'ask')
    expect(admit).toHaveBeenCalledTimes(elapsed < 60_000 ? 1 : 0)
    expect(spent).toHaveBeenCalledTimes(elapsed < 60_000 ? 1 : 0)
    if (elapsed < 60_000) expect(spent).toHaveBeenCalledWith([DECIDER])
  })

  it('refuses a proof that expires before its decision is recorded without losing the pending ask', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { registry, token, decision, grants } = await queue()
    expect(await registry.resolve(decision, 'admin', { consumeNotAfter: now })).toMatchObject({ ok: false, reason: expect.stringContaining('expired') })
    expect(registry.pending().map(request => request.token)).toEqual([token])
    expect(registry.unspent('s')).toEqual([])
    expect(grants.list()).toEqual([])
  })

  it('refuses admission if policy checking crosses expiry and never spends the stale grant', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, decision, evaluate } = await queue()
    const deadline = now + 60_000
    await registry.resolve(decision, 'admin', { consumeNotAfter: deadline })
    const admit = vi.fn(() => true)
    const spent = vi.fn()
    const outcome = await evaluate({ admit, spent, check: subjects => {
      if (subjects.length) { now = deadline; return { kind: 'allow', allowedBy: ['once'] } }
      return { kind: 'ask', asks: [{ ...prompt, offeredScopes: [...prompt.offeredScopes] }] }
    } })
    expect(outcome.kind).toBe('ask')
    expect(admit).not.toHaveBeenCalled()
    expect(spent).not.toHaveBeenCalled()
  })

  it('keeps a refused admission unspent but does not extend its proof deadline', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, decision, evaluate } = await queue()
    const deadline = now + 60_000
    await registry.resolve(decision, 'admin', { consumeNotAfter: deadline })
    expect((await evaluate({ admit: () => false })).kind).toBe('allow')
    expect(registry.unspent('s')).toHaveLength(1)
    now = deadline
    const admitted = vi.fn(() => true)
    expect((await evaluate({ admit: admitted })).kind).toBe('ask')
    expect(admitted).not.toHaveBeenCalled()
  })

  it('does not regrant, announce another answer, or renew the deadline on an identical later proof', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, file, decision, evaluate } = await queue()
    const sent: ApprovalNotice[] = []
    const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'node', graceMs: 1, interaction: async () => undefined, notices: createApprovalNotices(async notices => { sent.push(...notices) }) })
    const deadline = now + 60_000
    try {
      expect(await service.answer({ decision, authority: 'admin', decidedBy: DECIDER, consumeNotAfter: deadline })).toMatchObject({ ok: true })
      now += 30_000
      expect(await service.answer({ decision, authority: 'admin', decidedBy: DECIDER, consumeNotAfter: now + 60_000 })).toMatchObject({ ok: true, repeated: true })
      const stored = JSON.parse(readFileSync(file, 'utf8')) as { once: Array<{ expiresAt: string }> }
      expect(stored.once).toHaveLength(1)
      expect(Date.parse(stored.once[0]!.expiresAt)).toBe(deadline)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ event: 'answered', consumeNotAfter: new Date(deadline).toISOString() })
      now = deadline
      expect((await evaluate()).kind).toBe('ask')
    } finally { await service.close() }
  })

  it('starts the proof window after a long pending wait rather than when the ask was raised', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, decision, evaluate } = await queue()
    now += 5 * 60_000
    await registry.resolve(decision, 'admin', { consumeNotAfter: now + 60_000 })
    now += 59_999
    expect((await evaluate()).kind).toBe('allow')
  })

  it('keeps ordinary local once approvals usable beyond the signed proof window', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, decision, evaluate } = await queue()
    await registry.resolve(decision, 'admin')
    now += 2 * 60_000
    expect((await evaluate()).kind).toBe('allow')
  })

  it('does not time out execution already admitted before expiry', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { registry, decision, evaluate } = await queue()
    const deadline = now + 60_000
    await registry.resolve(decision, 'admin', { consumeNotAfter: deadline })
    let admittedAt: number | undefined
    const outcome: PermissionOutcome = await evaluate({ admit: () => { admittedAt = now; now += 2 * 60_000; return true } })
    expect(admittedAt).toBeLessThan(deadline)
    expect(outcome.kind).toBe('allow')
    expect(registry.unspent('s')).toEqual([])
  })
})
