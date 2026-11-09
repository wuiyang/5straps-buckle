import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GrantScope } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryNonceClaims } from '../common/adapters/approval/memory-nonce-claims.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { DEFAULT_SESSION_IDLE_MS } from '../common/domain/approval/session-idle.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { logger } from '../common/runtime/log.js'
import { grantLookup } from '../common/services/approvals/approval-gate.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { createSessionIdleCheck } from '../common/services/approvals/session-idle-check.js'
import type { ApprovalBackend } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { GrantStore } from '../common/types/ports/grant-store.js'
import { UNHEARD_DECISIONS } from './support/decision-audit.js'

// A revoke or a session end the ledger committed is owed to the grant store until the grants it names are gone: their
// approvals clear no call meanwhile, in any process, and the next decision, ask, or opening removes them, never reaching a
// grant made after.

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const WORKSPACE = 'w-1'
const MINUTE = 60_000
const CALL = { arguments: {}, cwd: '/', description: null, complete: true as const }

/** A ledger over a grants file whose removals fail while `broken` says so; writes still work. */
function setUp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-owed-removal-')))
  roots.push(root)
  const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: WORKSPACE })
  const broken = { removals: false }
  const refuse = () => { if (broken.removals) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }) }
  const grants: GrantStore = {
    ...store,
    endSessions: async (ending, endedAt) => { refuse(); return store.endSessions(ending, endedAt) },
    revoke: async (id) => { refuse(); return store.revoke(id) },
  }
  const approvals = join(root, 'approvals.json')
  const registry = createApprovalRegistry(grants, approvals, 15_000)
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  return { root, store, registry, approvals, broken, revocations: join(root, 'approval-revocations.json') }
}

let sequence = 0
async function asked(registry: ApprovalRegistry, sessionId: string, subject: string): Promise<string> {
  const result = await registry.ask({ tool: 'fs_write', sessionId, requestId: `request-${++sequence}`, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject, reason: 'outside', offeredScopes: ['once', 'session', 'always'] }], call: CALL })
  return result.requests[0]!.token
}

async function granted(registry: ApprovalRegistry, sessionId: string, subject: string, scope: GrantScope = 'session'): Promise<string> {
  const token = await asked(registry, sessionId, subject)
  expect(await registry.resolve({ token, approved: true, scope }, SOURCES.cli)).toMatchObject({ ok: true })
  return token
}

/** What a call of `sessionId` would be cleared by, through the ledger's grants as every caller reads them. */
const clearing = (registry: ApprovalRegistry, sessionId: string, suspended = false) =>
  grantLookup({ store: registry.grants, holder: { sessionId }, consumed: [], sessionApprovalsSuspended: suspended }).subjectsFor('write_scope')

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

describe('a session end whose grant removal fails', () => {
  it('withholds the ended session\'s approvals, also once activity resumes, until the next ask removes them', async () => {
    const { store, registry, approvals, broken } = setUp()
    await granted(registry, 'chat-1', '/outside/a')
    const terminal: ApprovalBackend = { open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }), submit: async () => ({ kind: 'accepted', refs: [] }), async notify() {}, close: async () => undefined }
    const service = createApprovalService({ registry, workspaceId: WORKSPACE, serverId: 'node-1', graceMs: 200, hold: async () => 'grace', terminal, nonces: createMemoryNonceClaims(), decisionAudit: UNHEARD_DECISIONS })
    let lastAt = Date.now() - 16 * MINUTE
    const check = createSessionIdleCheck({ workspaceId: WORKSPACE, idleMs: () => DEFAULT_SESSION_IDLE_MS, lastActivity: () => lastAt, executing: () => ({ running: [], stalled: [] }), asking: () => registry.askingSessions(), runningHere: () => false, held: () => registry.heldSessions(), sessions: service })
    broken.removals = true

    await check.check()
    expect(store.list().map(grant => grant.subject)).toEqual(['/outside/a'])
    expect(clearing(registry, 'chat-1', check.sessionApprovalsSuspended({ sessionId: 'chat-1' }))).toEqual([])
    lastAt = Date.now()
    await check.check()
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(false)
    expect(clearing(registry, 'chat-1')).toEqual([])
    expect(clearing(createApprovalRegistry(store, approvals), 'chat-1')).toEqual([])

    broken.removals = false
    await asked(registry, 'chat-2', '/outside/b')
    expect(store.list()).toEqual([])
    await service.close()
  })

  it('keeps a session approval made after the end when the end\'s removal is done late', async () => {
    const { store, registry, broken } = setUp()
    await granted(registry, 'mcp', '/outside/old')
    broken.removals = true
    await expect(registry.endSessions({ ending: { sessionId: 'mcp' } })).rejects.toThrow('read-only')
    await settle()

    await granted(registry, 'mcp', '/outside/new')
    expect(clearing(registry, 'mcp')).toEqual(['/outside/new'])
    broken.removals = false
    await asked(registry, 'mcp', '/outside/later')
    expect(store.list().map(grant => grant.subject)).toEqual(['/outside/new'])
  })

  it('removes at the opening after a repair the grants an end could not remove while approvals.json was unreadable, and keeps the record until then', async () => {
    const { store, registry, approvals, broken, revocations } = setUp()
    await granted(registry, 'chat-1', '/outside/a')
    const kept = readFileSync(approvals, 'utf8')
    writeFileSync(approvals, '{')
    broken.removals = true

    await expect(registry.endSessions({ ending: { sessions: [{ sessionId: 'chat-1' }] } })).rejects.toThrow('read-only')
    expect(clearing(registry, 'chat-1')).toEqual([])
    writeFileSync(approvals, kept)
    await registry.recover()
    expect(store.list().map(grant => grant.subject)).toEqual(['/outside/a'])
    expect(existsSync(revocations)).toBe(true)
    expect(clearing(registry, 'chat-1')).toEqual([])

    broken.removals = false
    await registry.recover()
    expect(store.list()).toEqual([])
    expect(existsSync(revocations)).toBe(false)
  })

  it('keeps one record of a session\'s end however many come while approvals.json is unreadable, and writes no grants for one that finds none', async () => {
    const { root, store, registry, approvals, revocations } = setUp()
    await granted(registry, 'chat-1', '/outside/a')
    writeFileSync(approvals, '{')
    await registry.endSessions({ ending: { sessions: [{ sessionId: 'chat-1' }] } })
    const grants = readFileSync(join(root, 'grants.json'), 'utf8')
    const written = vi.spyOn(store, 'endSessions')

    await registry.endSessions({ ending: { sessions: [{ sessionId: 'chat-1' }] } })
    await registry.endSessions({ ending: { sessions: [{ sessionId: 'chat-1' }] } })
    expect((JSON.parse(readFileSync(revocations, 'utf8')) as { revoked: unknown[] }).revoked).toHaveLength(1)
    expect(written).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'grants.json'), 'utf8')).toBe(grants)
  })

  it('removes, at a skip, a grant its session end gave up and left standing', async () => {
    const { store, registry, broken } = setUp()
    const token = await granted(registry, 'chat-1', '/outside/a')
    broken.removals = true
    await expect(registry.endSessions({ ending: { sessionId: 'chat-1' } })).rejects.toThrow('read-only')

    broken.removals = false
    expect(await registry.skipSave({ token, source: SOURCES.cli })).toEqual({ ok: true, repeated: true, removed: true })
    expect(store.list()).toEqual([])
  })
})

describe('a revoke whose grant removal fails', () => {
  it('withholds the revoked always grant until the next decision removes it', async () => {
    const { store, registry, broken } = setUp()
    await granted(registry, 'chat-1', '/outside/a', 'always')
    const [grant] = store.list()
    broken.removals = true

    await expect(registry.grants.revoke(grant!.id)).rejects.toThrow('read-only')
    expect(store.list()).toHaveLength(1)
    expect(clearing(registry, 'chat-2')).toEqual([])

    broken.removals = false
    await granted(registry, 'chat-2', '/outside/b', 'once')
    expect(store.list()).toEqual([])
  })
})
