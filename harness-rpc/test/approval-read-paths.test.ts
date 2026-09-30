import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalNotice } from '@5straps/protocol'
import { callDigestOf, generateSigningKey, shownCallDigestOf, signChallenge, signingKeyFromPem } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalNotices } from '../common/services/approvals/approval-notices.js'
import { createApprovalRegistry, MAX_PENDING_BYTES_PER_SESSION, MAX_PENDING_PER_SESSION, type AskedCall } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ask = (subject = '/outside') => ({ kind: 'ask' as const, rule: 'write_scope' as const, subject, reason: 'outside', offeredScopes: ['once', 'session', 'always'] as const })
const whole = (bytes = 1_000): AskedCall => ({ arguments: { content: 'x'.repeat(bytes) }, cwd: '/workspace', description: 'Write files', effects: ['write /outside'], complete: true })
function queue() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-read-paths-'))
  roots.push(root)
  const filePath = join(root, 'approvals.json')
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  const registry = createApprovalRegistry(grants, filePath, root)
  const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'node-1', graceMs: 1, interaction: async () => undefined })
  return { root, filePath, grants, registry, service }
}

function asks(count: number) { return Array.from({ length: count }, (_, index) => ({ ...ask(`/outside/${index}`), offeredScopes: [...ask().offeredScopes] })) }

const issue = (registry: ReturnType<typeof createApprovalRegistry>, call: AskedCall | undefined = whole()) => registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: asks(1), ...(call ? { call } : {}) })

describe('approval listings carry each whole call once', () => {
  it('keeps ten sessions of fifty one-MiB asks bounded across reads and signed listings', async () => {
    const { registry, service } = queue()
    try {
      for (let session = 0; session < 10; session++) await registry.ask({ tool: 'fs_write_batch', sessionId: `session-${session}`, actor: 'agent', asks: asks(50), call: { ...whole(1_024 * 1_024), cwd: `/workspace/${session}` } })
      const waiting = registry.waiting()
      expect(waiting).toHaveLength(500)
      expect(new Set(waiting.map(entry => entry.call)).size).toBe(10)
      const admin = service.listing()
      expect(admin.filter(entry => entry.call)).toHaveLength(10)
      expect(admin.every(entry => entry.callRef)).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(admin))).toBeLessThan(11 * 1_024 * 1_024)
      const listing = service.challengeListing()
      expect(Object.keys(listing.calls)).toHaveLength(10)
      expect(listing.challenges.every(entry => entry.challenge?.arguments === null)).toBe(true)
      const key = signingKeyFromPem(generateSigningKey().privateKeyPem)
      const signed = listing.challenges.map(entry => ({ token: entry.token, ...signChallenge({ challenge: entry.challenge!, key: key.privateKey }) }))
      expect(Buffer.byteLength(JSON.stringify({ calls: listing.calls, challenges: signed }))).toBeLessThan(12 * 1_024 * 1_024)
      const named = registry.waitingAsk(waiting[400]!.request.token)
      expect(named?.callRef).toBe(waiting[400]!.callRef)
      expect(named?.call?.arguments).toEqual(waiting[400]!.call!.arguments)
    } finally { await service.close() }
  })

  it('shares large effects as well as arguments and binds every displayed field', async () => {
    const { registry, service } = queue()
    const call = { ...whole(), effects: ['write /outside/', 'exec ' + 'argument '.repeat(4_000)] }
    try {
      await registry.ask({ tool: 'fs_write_batch', sessionId: 'mcp', asks: asks(50), call })
      const listing = service.challengeListing()
      const challenge = listing.challenges[0]!.challenge!
      expect(challenge).toMatchObject({ arguments: null, cwd: null, description: null, effects: null })
      const shared = listing.calls[challenge.callRef!]!
      expect(shared).toMatchObject({ tool: 'fs_write_batch', arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects })
      expect(challenge.callRef).toBe(shownCallDigestOf(shared))
      expect(challenge.callDigest).toBe(callDigestOf(shared))
      expect(Buffer.byteLength(JSON.stringify(listing))).toBeLessThan(128 * 1_024)
      for (const changed of [{ ...shared, cwd: '/different' }, { ...shared, description: 'Different summary' }, { ...shared, effects: ['write /different'] }, { ...shared, arguments: { content: 'different' } }]) expect(shownCallDigestOf(changed)).not.toBe(challenge.callRef)
      const decided = await service.answer({ decision: { token: challenge.token, approved: true, scope: 'once' }, authority: 'admin', challenge: signChallenge({ challenge, key: signingKeyFromPem(generateSigningKey().privateKeyPem).privateKey }).digest })
      expect(decided.ok).toBe(true)
    } finally { await service.close() }
  })
})

describe('every decision needs a complete recorded call', () => {
  it.each(['missing', 'missing_file', 'incomplete', 'unreadable'] as const)('refuses every approving scope for a %s call and still permits denial', async (kind) => {
    const { root, registry, grants, service } = queue()
    const call = kind === 'missing' ? undefined : kind === 'incomplete' ? { ...whole(), complete: undefined } : whole()
    try {
      const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: asks(1), ...(call ? { call } : {}) })).requests
      if (kind === 'missing_file') rmSync(join(root, 'approval-calls', readdirSync(join(root, 'approval-calls'))[0]!))
      if (kind === 'unreadable') writeFileSync(join(root, 'approval-calls', readdirSync(join(root, 'approval-calls'))[0]!), 'invalid JSON')
      for (const scope of ['once', 'session', 'always'] as const) expect(await registry.resolve({ token: request!.token, approved: true, scope }, 'admin')).toMatchObject({ ok: false, reason: expect.stringContaining('recorded before this build') })
      expect(grants.list()).toEqual([])
      expect(registry.unspent('mcp')).toEqual([])
      expect(registry.pending()).toHaveLength(1)
      expect((await registry.resolve({ token: request!.token, approved: false, scope: 'once' }, 'admin')).ok).toBe(true)
      expect(registry.pending()).toEqual([])
    } finally { await service.close() }
  })
})

describe('approval caps distinguish the actor and session pair', () => {
  it('keeps an HTTP caller using mcp from filling the stdio host count cap', async () => {
    const { registry, service } = queue()
    try {
      await registry.ask({ tool: 'fs_write_batch', sessionId: 'mcp', actor: 'http-agent', asks: asks(MAX_PENDING_PER_SESSION), call: whole() })
      await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'http-agent', asks: asks(1), call: whole() })).rejects.toThrow('This session already has')
      expect((await registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'stdio-host', asks: asks(1), call: whole() })).requests).toHaveLength(1)
    } finally { await service.close() }
  })

  it('keeps the same session name from sharing its byte cap between callers', async () => {
    const { registry, service } = queue()
    try {
      await registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'http-agent', asks: asks(1), call: whole(MAX_PENDING_BYTES_PER_SESSION - 64 * 1_024) })
      await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'http-agent', asks: asks(1), call: whole(128 * 1_024) })).rejects.toThrow('per session')
      expect((await registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'stdio-host', asks: asks(1), call: whole(128 * 1_024) })).requests).toHaveLength(1)
    } finally { await service.close() }
  })
})

describe('expired approval cleanup runs without another approval event', () => {
  it('prunes expired asks, files and notices before an ordinary allowed call returns', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    const expired: string[] = []
    const watching = createApprovalRegistry(grants, filePath, root, 0, { onExpired: requests => expired.push(...requests.map(request => request.token)) })
    try {
      const [request] = (await issue(watching)).requests
      vi.setSystemTime(Date.now() + 11 * 60_000)
      expect(await watching.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'allow', allowedBy: [] }) })).toMatchObject({ kind: 'allow' })
      expect(expired).toEqual([request!.token])
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
      expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
      expect(registry.pending()).toEqual([])
    } finally { await service.close() }
  })

  it('notices another process adding asks after this process started with an empty queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    try {
      await service.close()
      const expired: string[] = []
      const serving = createApprovalRegistry(grants, filePath, root, 0, { onExpired: requests => expired.push(...requests.map(request => request.token)) })
      await serving.sweepIfDue()
      const [request] = (await issue(registry)).requests
      vi.setSystemTime(Date.now() + 11 * 60_000)
      expect(await serving.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'allow', allowedBy: [] }) })).toMatchObject({ kind: 'allow' })
      expect(expired).toEqual([request!.token])
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
      expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
    } finally { await service.close() }
  })

  it('awaits process-start pruning and expiry notice delivery when the service closes immediately', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    await service.close()
    const [request] = (await issue(registry)).requests
    writeFileSync(join(root, 'approval-calls', 'orphan.tmp'), 'abandoned write')
    vi.setSystemTime(Date.now() + 11 * 60_000)
    const sent: ApprovalNotice[] = []
    const notices = createApprovalNotices(async batch => { await new Promise(resolve => setTimeout(resolve, 20)); sent.push(...batch) })
    const restarted = createApprovalRegistry(grants, filePath, root, 0, { onExpired: requests => notices.expired(requests) })
    const closing = createApprovalService({ registry: restarted, workspaceId: 'default', serverId: 'node-1', graceMs: 1, interaction: async () => undefined, notices })
    await closing.close()
    expect(sent).toEqual([expect.objectContaining({ token: request!.token, event: 'expired' })])
    expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
    expect(existsSync(join(root, 'approval-calls', 'orphan.tmp'))).toBe(false)
    expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
  })
})
