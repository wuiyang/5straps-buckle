import { describe, expect, it } from 'vitest'
import { approvalKey, createMemoryNonceStore, EnvelopeError, ENVELOPE_WINDOW_MS, mintApprovalKey, open, seal, sealedReport, SEALED_REPORT_PATHS, type EnvelopeRefusal, type SealedEnvelope } from '../src/envelope.js'

const key = approvalKey(mintApprovalKey())
const route = { method: 'POST', path: '/setup/approvals' }
const body = { token: 'tok-1', approved: true, scope: 'once' }
const now = 1_800_000_000_000

function refusal(run: () => unknown): EnvelopeRefusal | null {
  try { run(); return null } catch (error) { return error instanceof EnvelopeError ? error.reason : null }
}

function sealed(overrides: Partial<SealedEnvelope> = {}, at = now): SealedEnvelope {
  return { ...seal(key, { ...route, body, now: at }), ...overrides }
}

describe('sealed envelope', () => {
  it('round-trips a body and hides it in the ciphertext', () => {
    const envelope = sealed()
    expect(envelope).toMatchObject({ v: 1, keyId: key.id, ts: now })
    expect(JSON.stringify(envelope)).not.toContain('tok-1')
    expect(open(key, envelope, { ...route, now, seen: createMemoryNonceStore() })).toEqual(body)
  })

  it('refuses the same envelope twice inside the window', () => {
    const seen = createMemoryNonceStore()
    const envelope = sealed()
    open(key, envelope, { ...route, now, seen })
    expect(refusal(() => open(key, envelope, { ...route, now: now + 1_000, seen }))).toBe('replayed')
  })

  it.each([['past', -1], ['future', 1]])('refuses a timestamp beyond the window in the %s', (_, sign) => {
    const envelope = sealed({}, now + sign * (ENVELOPE_WINDOW_MS + 1))
    expect(refusal(() => open(key, envelope, { ...route, now, seen: createMemoryNonceStore() }))).toBe('expired')
    const edge = sealed({}, now + sign * ENVELOPE_WINDOW_MS)
    expect(refusal(() => open(key, edge, { ...route, now, seen: createMemoryNonceStore() }))).toBeNull()
  })

  it('refuses a changed ciphertext, timestamp or nonce', () => {
    const envelope = sealed()
    const bytes = Buffer.from(envelope.ciphertext, 'base64url')
    bytes[0] = bytes[0]! ^ 1
    const seen = createMemoryNonceStore()
    expect(refusal(() => open(key, { ...envelope, ciphertext: bytes.toString('base64url') }, { ...route, now, seen }))).toBe('tampered')
    expect(refusal(() => open(key, { ...envelope, ts: now + 1 }, { ...route, now, seen }))).toBe('tampered')
    expect(refusal(() => open(key, { ...envelope, nonce: sealed().nonce }, { ...route, now, seen }))).toBe('tampered')
  })

  it('refuses the envelope on another path or method', () => {
    const envelope = sealed()
    expect(refusal(() => open(key, envelope, { method: 'POST', path: '/workspaces/other/setup/approvals', now, seen: createMemoryNonceStore() }))).toBe('tampered')
    expect(refusal(() => open(key, envelope, { method: 'PUT', path: route.path, now, seen: createMemoryNonceStore() }))).toBe('tampered')
  })

  it('refuses a key id that is not this key, and a key it names but cannot open', () => {
    const other = approvalKey(mintApprovalKey())
    expect(refusal(() => open(other, sealed(), { ...route, now, seen: createMemoryNonceStore() }))).toBe('unknown_key')
    expect(refusal(() => open(other, sealed({ keyId: other.id }), { ...route, now, seen: createMemoryNonceStore() }))).toBe('tampered')
  })

  it('refuses a malformed envelope as tampered and does not spend its nonce', () => {
    const seen = createMemoryNonceStore()
    expect(refusal(() => open(key, { v: 1, ciphertext: 'x' }, { ...route, now, seen }))).toBe('tampered')
    const envelope = sealed()
    expect(refusal(() => open(key, { ...envelope, ciphertext: 'AAAA' }, { ...route, now, seen }))).toBe('tampered')
    expect(open(key, envelope, { ...route, now, seen })).toEqual(body)
  })

  it('refuses a key that is not 32 bytes of base64url', () => {
    expect(() => approvalKey('short')).toThrow()
    expect(() => approvalKey(`${mintApprovalKey().slice(0, 42)}=`)).toThrow()
  })
})

describe('memory nonce store', () => {
  it('forgets a nonce once its timestamp leaves the window', () => {
    const store = createMemoryNonceStore()
    expect(store.claim({ keyId: 'k', nonce: 'n', ts: now, now })).toBe(true)
    expect(store.claim({ keyId: 'k', nonce: 'n', ts: now, now: now + ENVELOPE_WINDOW_MS })).toBe(false)
    expect(store.claim({ keyId: 'k', nonce: 'other', ts: now + ENVELOPE_WINDOW_MS * 2, now: now + ENVELOPE_WINDOW_MS * 2 })).toBe(true)
    expect(store.size()).toBe(1)
  })
})

describe('sealed report', () => {
  it('seals a report for its route once a key is held, and leaves it plain before', () => {
    const path = SEALED_REPORT_PATHS.reports
    const report = { reports: [{ id: 'r-1' }] }
    const envelope = sealedReport(key, path, report)
    expect(open(key, envelope, { method: 'POST', path, now: Date.now(), seen: createMemoryNonceStore() })).toEqual(report)
    expect(sealedReport(undefined, path, report)).toBe(report)
  })
})
