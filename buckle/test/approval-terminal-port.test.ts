import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliOutcome, RequestCli } from '@5straps/runtime'
import type { PermissionRuleId } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryNonceClaims } from '../common/adapters/approval/memory-nonce-claims.js'
import { NO_DECISION_AUDIT } from '../common/adapters/approval/no-decision-audit.js'
import { createTerminalBackend } from '../common/adapters/approval/terminal-backend.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { createApprovalRegistry, MAX_PENDING_PER_SESSION } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, type ApprovalAskInput } from '../common/services/approvals/approval-service.js'
import type { ApprovalBackend, ApprovalHost, DecisionInput, DecisionReceipt, FullAsk, LifecycleEvent } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The core side of the port: what the service hands its terminal backend, and how it takes the backend's decisions.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A backend that records what core hands it and decides as each test says, once its asks arrive. */
function recordingBackend(decide: (host: ApprovalHost, asks: FullAsk[]) => Promise<DecisionReceipt[]>) {
  const seen: { host?: ApprovalHost; asks: FullAsk[]; events: LifecycleEvent[]; receipts: DecisionReceipt[]; closed: boolean } = { asks: [], events: [], receipts: [], closed: false }
  const backend: ApprovalBackend = {
    async open(host) {
      seen.host = host
      return { contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: true, revokes: false }
    },
    async submit(asks) {
      seen.asks.push(...asks)
      seen.receipts.push(...await decide(seen.host!, asks))
      return { kind: 'accepted', refs: [] }
    },
    async notify(events) { seen.events.push(...events) },
    async close() { seen.closed = true },
  }
  return { backend, seen }
}

function setUp(backend: ApprovalBackend, graceMs: number | null = 200) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-terminal-port-'))
  roots.push(root)
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000)
  const service = createApprovalService({ registry, workspaceId: 'w-1', workspaceName: 'The site', serverId: 'node-1', graceMs, hold: async () => 'grace', terminal: backend, nonces: createMemoryNonceClaims(), decisionAudit: NO_DECISION_AUDIT })
  return { registry, grants, service, root }
}

/** The same ledger as a second process opens it. */
function otherProcess(root: string) {
  return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 15_000)
}

/** A terminal that holds each question until it is withdrawn, recording what it showed and what it withdrew. */
function heldTerminal() {
  const shown: string[] = []
  const withdrawn: string[] = []
  const requestCli: RequestCli = (request, options) => {
    shown.push(request.id)
    return new Promise<CliOutcome>((resolve) => {
      options?.signal?.addEventListener('abort', () => {
        withdrawn.push(request.id)
        resolve({ status: 'cancelled', requestId: request.id, reason: 'withdrawn' })
      }, { once: true })
    })
  }
  return { requestCli, shown, withdrawn }
}

const ask = (subject: string, rule: PermissionRuleId = 'write_scope', extra: { widerSubject?: string } = {}) => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule, subject, reason: 'outside the workspace', offeredScopes: ['once' as const, 'session' as const], ...extra })
const CALL = { arguments: { path: '/outside/a.md', content: 'x' }, cwd: '/workspace', description: 'Writes a.md', effects: ['write /outside/a.md'], complete: true as const }
const call = (overrides: Partial<ApprovalAskInput> = {}): ApprovalAskInput => ({ sessionId: 'chat-1', requestId: 'request-1', tool: 'fs_write', call: CALL, asks: [ask('/outside/a.md')], ...overrides })

describe('the terminal backend port, core side', () => {
  it('hands the terminal each ask whole, under the call\'s join key', async () => {
    const { backend, seen } = recordingBackend(async () => [])
    const { service } = setUp(backend)
    await service.request(call({ asks: [ask('/outside/a.md'), ask('/outside/b.md')] }))
    expect(seen.host?.source).toEqual(SOURCES.terminal)
    expect(seen.asks).toHaveLength(2)
    const [first, second] = seen.asks
    expect(first).toMatchObject({
      egress: 'full', contractVersion: 1, correlation: { correlationId: 'request-1', requestId: 'request-1' },
      workspace: { id: 'w-1', name: 'The site', node: 'node-1' }, requester: { actor: null, sessionId: 'chat-1' }, tool: 'fs_write',
      policy: { rule: 'write_scope', subject: '/outside/a.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] },
      risk: { notes: [] }, deadline: { hold: 'grace' },
      action: { arguments: CALL.arguments, cwd: CALL.cwd, description: CALL.description, effects: CALL.effects },
    })
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey)
    expect(second?.group).toBe(first?.group)
    await service.close()
    expect(seen.closed).toBe(true)
  })

  it('names the call by a key that carries none of its session, actor, or requestId', async () => {
    const { backend, seen } = recordingBackend(async () => [])
    const { service } = setUp(backend)
    await service.request(call({ sessionId: 'chat-secret', requestId: 'request-secret' }))
    await service.request(call({ sessionId: 'chat-secret', requestId: 'request-other' }))
    const [first, second] = seen.asks
    expect(first?.idempotencyKey).not.toMatch(/chat-secret|request-secret/)
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey)
    await service.close()
  })

  it('applies a terminal approval as the terminal source, and grants a wider subject the ask offers', async () => {
    const { backend, seen } = recordingBackend(async (host, asks) => Promise.all(asks.map(asked => host.decide({ kind: 'plain', decision: { token: asked.token, outcome: 'approve', scope: 'session', ...(asked.policy.widerSubject ? { widen: 'below' as const } : {}) } }))))
    const { service, grants } = setUp(backend)
    const result = await service.request(call({ asks: [ask('delete:/outside/reports', 'write_scope', { widerSubject: 'delete-below:/outside/reports' })] }))
    expect(result.settled).toBe(true)
    expect(seen.receipts).toEqual([{ status: 'applied', state: 'approved', assurance: 'local' }])
    expect(grants.list().map(grant => grant.subject)).toEqual(['delete-below:/outside/reports'])
    await service.close()
  })

  it('answers a decision sent again as repeated, and says when a decision\'s grant is still owed', async () => {
    const approve = (token: string): DecisionInput => ({ kind: 'plain', decision: { token, outcome: 'approve', scope: 'session' } })
    const { backend, seen } = recordingBackend(async (host, asks) => [await host.decide(approve(asks[0]!.token)), await host.decide(approve(asks[0]!.token))])
    const { service, grants } = setUp(backend)
    vi.spyOn(grants, 'grant').mockRejectedValueOnce(new Error('The grants file was busy'))
    await service.request(call())
    await vi.waitFor(() => expect(seen.receipts).toHaveLength(2))
    expect(seen.receipts).toEqual([
      { status: 'applied', state: 'approved', assurance: 'local', grantOwed: true },
      { status: 'repeated', state: 'approved' },
    ])
    expect(grants.list().map(grant => grant.subject)).toEqual(['/outside/a.md'])
    await service.close()
  })

  it('says a repeated decision\'s grant is still owed when sending it again could not write it either', async () => {
    const approve = (token: string): DecisionInput => ({ kind: 'plain', decision: { token, outcome: 'approve', scope: 'session' } })
    const { backend, seen } = recordingBackend(async (host, asks) => [await host.decide(approve(asks[0]!.token)), await host.decide(approve(asks[0]!.token))])
    const { service, grants } = setUp(backend)
    vi.spyOn(grants, 'grant').mockRejectedValue(new Error('The grants file was busy'))
    await service.request(call())
    await vi.waitFor(() => expect(seen.receipts).toHaveLength(2))
    expect(seen.receipts[1]).toEqual({ status: 'repeated', state: 'approved', grantOwed: true })
    await service.close()
  })

  it('refuses a decision that does not read as one before the ledger, and records nothing', async () => {
    const malformed = [{ outcome: 'maybe', scope: 'once' }, { outcome: 'deny', scope: 'forever' }, { outcome: 'approve', scope: 'once', widen: 'above' }, { outcome: 'deny', scope: 'once', subject: '/elsewhere' }]
    const { backend, seen } = recordingBackend(async (host, asks) => Promise.all(malformed.map(body => host.decide({ kind: 'plain', decision: { token: asks[0]!.token, ...body } } as unknown as DecisionInput))))
    const { service, registry, grants } = setUp(backend)
    await service.request(call())
    expect(seen.receipts).toEqual(malformed.map(() => ({ status: 'refused', error: { code: 'statement_invalid', message: 'Invalid approval decision', retryable: false } })))
    expect(registry.pending()).toHaveLength(1)
    expect(grants.list()).toEqual([])
    await service.close()
  })

  it('closes a backend whose submit settles only once the backend is closed', async () => {
    const asked = Promise.withResolvers<void>()
    let release: (() => void) | undefined
    const backend: ApprovalBackend = {
      open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
      submit: () => new Promise((resolve) => { release = () => resolve({ kind: 'accepted', refs: [] }); asked.resolve() }),
      notify: async () => undefined,
      close: async () => { release?.() },
    }
    const { service } = setUp(backend)
    await service.request(call({ wait: { mode: 'none' } }))
    await asked.promise
    const ended = await Promise.race([service.close().then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('stuck'), 2_000))])
    expect(ended).toBe('closed')
  })

  it('refuses with the guard\'s code, and refuses a token it never routed to the terminal', async () => {
    const { backend, seen } = recordingBackend(async (host, asks) => [
      await host.decide({ kind: 'plain', decision: { token: asks[0]!.token, outcome: 'approve', scope: 'always' } }),
      await host.decide({ kind: 'plain', decision: { token: 'not-routed', outcome: 'deny', scope: 'once' } }),
      await host.decide({ kind: 'plain', decision: { token: asks[0]!.token, outcome: 'approve', scope: 'session', widen: 'below' } }),
    ])
    const { service, registry } = setUp(backend)
    await service.request(call())
    expect(seen.receipts).toEqual([
      { status: 'refused', error: { code: 'scope_not_offered', message: 'Scope always is not offered for this approval', retryable: false } },
      { status: 'refused', error: { code: 'approver_not_allowed', message: 'This ask was not routed to the terminal', retryable: false } },
      { status: 'refused', error: { code: 'scope_not_offered', message: 'This ask has no wider subject to grant', retryable: false } },
    ])
    expect(registry.pending()).toHaveLength(1)
    await service.close()
  })

  it('tells the terminal how each of its asks left the queue, once', async () => {
    const { backend, seen } = recordingBackend(async () => [])
    const { service } = setUp(backend)
    const waiting = service.request(call({ asks: [ask('/outside/a.md'), ask('/outside/b.md')], wait: { mode: 'finite', ms: 5_000 } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const [first, second] = seen.asks
    await service.answer({ decision: { token: first!.token, approved: true, scope: 'once' }, source: SOURCES.cli })
    await service.answer({ decision: { token: second!.token, approved: false, scope: 'once' }, source: SOURCES.cli })
    await waiting
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen.events.map(event => [event.token, event.type])).toEqual([[first!.token, 'answered'], [second!.token, 'denied']])
    await service.close()
  })
})

/** A backend that keeps asking until core stops it, recording each event core sends. */
function holdingBackend() {
  const events: LifecycleEvent[] = []
  const backend: ApprovalBackend = {
    open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
    submit: (_asks, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ kind: 'accepted', refs: [] }), { once: true })),
    async notify(sent) { events.push(...sent) },
    close: async () => undefined,
  }
  return { backend, events: () => events.map(event => ({ type: event.type, ...(event.reason === undefined ? {} : { reason: event.reason }) })) }
}

const MINUTE = 60_000

describe('how the service tells the terminal an ask left the queue', () => {
  afterEach(() => { vi.useRealTimers() })

  it('says the owner withdrew it', async () => {
    const terminal = holdingBackend()
    const { service } = setUp(terminal.backend)
    const [asked] = (await service.request(call())).approvals
    await service.withdrawCall({ token: asked!.token })
    await vi.waitFor(() => expect(terminal.events()).toEqual([{ type: 'cancelled', reason: 'withdrawn_by_owner' }]))
    await service.close()
  })

  it('says it expired', async () => {
    const terminal = holdingBackend()
    const { service, registry } = setUp(terminal.backend)
    await service.request(call())
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * MINUTE)
    await registry.sweep()
    await vi.waitFor(() => expect(terminal.events()).toEqual([{ type: 'expired' }]))
    await service.close()
  })

  it('says it expired when it lapsed ten minutes after its caller left, though it states no deadline', async () => {
    const terminal = holdingBackend()
    const { service, registry } = setUp(terminal.backend, null)
    const leaving = new AbortController()
    const waiting = service.request(call({ signal: leaving.signal, resends: true }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    leaving.abort()
    await expect(waiting).rejects.toThrow()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * MINUTE)
    await registry.sweep()
    await vi.waitFor(() => expect(terminal.events()).toEqual([{ type: 'expired' }]))
    await service.close()
  })

  it('says it was evicted to make room for a newer ask', async () => {
    const terminal = holdingBackend()
    const { service, registry } = setUp(terminal.backend)
    const leaving = new AbortController()
    const asks = Array.from({ length: MAX_PENDING_PER_SESSION }, (_, index) => ask(`/outside/${index}.md`))
    const waiting = service.request(call({ asks, signal: leaving.signal, resends: true }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(MAX_PENDING_PER_SESSION))
    leaving.abort()
    await expect(waiting).rejects.toThrow()
    await service.request(call({ requestId: 'request-2', asks: [ask('/outside/newer.md')], wait: { mode: 'none' } }))
    await vi.waitFor(() => expect(terminal.events()).toEqual([{ type: 'cancelled', reason: 'evicted' }]))
    await service.close()
  })

  it('says only that it was cancelled when another process withdrew it', async () => {
    const terminal = holdingBackend()
    const { service, root } = setUp(terminal.backend)
    const [asked] = (await service.request(call())).approvals
    await otherProcess(root).cancel([asked!.token])
    await vi.waitFor(() => expect(terminal.events()).toEqual([{ type: 'cancelled' }]))
    await service.close()
  })

  it('records a caller\'s own withdrawal as cancelled by its caller', async () => {
    const { registry } = setUp(holdingBackend().backend)
    const { requests } = await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r', asks: [ask('/outside/a.md')] })
    await registry.cancel([requests[0]!.token])
    expect(registry.departures([requests[0]!.token])).toEqual(new Map([[requests[0]!.token, { type: 'cancelled', reason: 'caller_cancelled' }]]))
  })
})

describe('the service and the terminal backend together', () => {
  it('asks a new group under the same requestId once the earlier one left the queue in another process while on screen', async () => {
    const terminal = heldTerminal()
    const { service, registry, root } = setUp(createTerminalBackend({ requester: async () => terminal.requestCli }), 150)
    const first = await service.request(call({ fingerprint: 'f' }))
    expect(first.settled).toBe(false)
    const [earlier] = first.approvals
    expect(terminal.shown).toEqual([`approval:w-1:${earlier!.token}`])
    await otherProcess(root).cancel([earlier!.token])
    const second = service.request(call({ fingerprint: 'f' }))
    await vi.waitFor(() => expect(terminal.shown).toHaveLength(2), { timeout: 1_500 })
    const [newer] = registry.pending()
    expect(terminal.shown[1]).toBe(`approval:w-1:${newer!.token}`)
    await second
    await service.close()
  })

  it('withdraws a question whose ask another route answered while on screen, and shows the next', async () => {
    const terminal = heldTerminal()
    const { service, root } = setUp(createTerminalBackend({ requester: async () => terminal.requestCli }), 5_000)
    const waiting = service.request(call({ asks: [ask('/outside/a.md'), ask('/outside/b.md')] }))
    await vi.waitFor(() => expect(terminal.shown).toHaveLength(1))
    const [first, second] = service.pending()
    await otherProcess(root).resolve({ token: first!.token, approved: true, scope: 'once' }, SOURCES.cli)
    await vi.waitFor(() => expect(terminal.shown).toHaveLength(2), { timeout: 1_500 })
    expect(terminal.withdrawn).toEqual([`approval:w-1:${first!.token}`])
    expect(terminal.shown[1]).toBe(`approval:w-1:${second!.token}`)
    await service.answer({ decision: { token: second!.token, approved: false, scope: 'once' }, source: SOURCES.cli })
    expect((await waiting).settled).toBe(true)
    await service.close()
  })
})
