import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * `RINGS-D20`: approval traffic between Rings and Buckle travels sealed under a key the pair
 * shares, minted by Rings at pairing. A receiver refuses a timestamp outside the window, a nonce
 * it has already seen inside it, and anything that does not verify. Imported by path
 * (`@5straps/protocol/envelope`) because it needs `node:crypto`, which Visual does not have.
 */
export const ENVELOPE_VERSION = 1
export const ENVELOPE_WINDOW_MS = 120_000
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** The key's transport and file form: 32 bytes, base64url without padding. */
export const APPROVAL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const SealedEnvelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ts: z.number().int().nonnegative(),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict()
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>

export type EnvelopeRefusal = 'expired' | 'replayed' | 'tampered' | 'unknown_key'

export class EnvelopeError extends Error {
  constructor(readonly reason: EnvelopeRefusal) {
    super(`Sealed body refused: ${reason}`)
    this.name = 'EnvelopeError'
  }
}

export interface ApprovalKey {
  id: string
  secret: Buffer
}

/** Remembers each nonce until its timestamp leaves the window. `claim` is false for one already held. */
export interface NonceStore {
  claim(input: { keyId: string; nonce: string; ts: number; now: number }): boolean
}

export function mintApprovalKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url')
}

/** Throws on anything but a 32-byte base64url key, so a truncated value never seals. */
export function approvalKey(encoded: string): ApprovalKey {
  if (!APPROVAL_KEY_PATTERN.test(encoded)) throw new Error('An approval key is 32 bytes in base64url')
  const secret = Buffer.from(encoded, 'base64url')
  // The id names the key without revealing it: a truncated hash under its own label.
  const id = createHash('sha256').update('5straps-approval-key-id\0').update(secret).digest('hex').slice(0, 16)
  return { id, secret }
}

/** A body that claims to be an envelope is judged as one, so a damaged envelope never reads as plain. */
export function looksSealed(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'v' in body && 'ciphertext' in body
}

export function seal(key: ApprovalKey, input: { method: string; path: string; body: unknown; now?: number }): SealedEnvelope {
  const nonce = randomBytes(NONCE_BYTES)
  const ts = input.now ?? Date.now()
  const header = { v: ENVELOPE_VERSION, keyId: key.id, nonce: nonce.toString('base64url'), ts } as const
  const cipher = createCipheriv('aes-256-gcm', key.secret, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(additionalData({ ...header, method: input.method, path: input.path }))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(input.body), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ...header, ciphertext: encrypted.toString('base64url') }
}

/** A report's body as it is posted: sealed for its route once the node holds a key, plain before. */
export function sealedReport(key: ApprovalKey | undefined, path: string, body: unknown): unknown {
  return key ? seal(key, { method: 'POST', path, body }) : body
}

/**
 * The window is checked first and costs nothing; the nonce is claimed only after the body
 * verifies, so a forged envelope cannot spend a genuine nonce.
 */
export function open(key: ApprovalKey, envelope: unknown, input: { method: string; path: string; now: number; seen: NonceStore }): unknown {
  const parsed = SealedEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) throw new EnvelopeError('tampered')
  const sealed = parsed.data
  if (!sameText(sealed.keyId, key.id)) throw new EnvelopeError('unknown_key')
  if (Math.abs(input.now - sealed.ts) > ENVELOPE_WINDOW_MS) throw new EnvelopeError('expired')
  const body = decrypt(key, sealed, input)
  if (!input.seen.claim({ keyId: sealed.keyId, nonce: sealed.nonce, ts: sealed.ts, now: input.now })) throw new EnvelopeError('replayed')
  return body
}

function decrypt(key: ApprovalKey, sealed: SealedEnvelope, input: { method: string; path: string }): unknown {
  const nonce = Buffer.from(sealed.nonce, 'base64url')
  const data = Buffer.from(sealed.ciphertext, 'base64url')
  if (nonce.length !== NONCE_BYTES || data.length <= TAG_BYTES) throw new EnvelopeError('tampered')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.secret, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(additionalData({ ...sealed, method: input.method, path: input.path }))
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES))
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as unknown
  } catch {
    throw new EnvelopeError('tampered')
  }
}

function additionalData(input: { v: number; method: string; path: string; keyId: string; ts: number; nonce: string }): Buffer {
  return Buffer.from([input.v, input.method.toUpperCase(), input.path, input.keyId, input.ts, input.nonce].join('|'), 'utf8')
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Held in memory; entries go once their timestamp leaves the window. */
export function createMemoryNonceStore(input: { windowMs?: number } = {}): NonceStore & { size(): number } {
  const windowMs = input.windowMs ?? ENVELOPE_WINDOW_MS
  const seen = new Map<string, number>()
  return {
    claim({ keyId, nonce, ts, now }) {
      for (const [entry, at] of seen) if (at < now - windowMs) seen.delete(entry)
      const entry = `${keyId}:${nonce}`
      if (seen.has(entry)) return false
      seen.set(entry, ts)
      return true
    },
    size: () => seen.size,
  }
}

/** The logical route an approval decision is sealed for, so one workspace's decision cannot land on another. */
export function approvalDecisionPath(workspaceId: string): string {
  return workspaceId === 'default' ? '/setup/approvals' : `/workspaces/${encodeURIComponent(workspaceId)}/setup/approvals`
}

/** The Rings routes a node reports to, named as sealed. A path prefix in front of Rings does not change them. */
export const SEALED_REPORT_PATHS = { reports: '/api/v1/buckle-reports', approvals: '/api/v1/buckle-approvals' } as const
