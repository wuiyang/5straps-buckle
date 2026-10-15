import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Constant-time comparison, so a wrong token leaks nothing through response timing. */
export function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  const expectedBuffer = Buffer.from(expected)
  if (supplied.byteLength !== expectedBuffer.byteLength) return false
  return timingSafeEqual(supplied, expectedBuffer)
}

/** A fresh agent token: 24 random bytes, shown once and stored by its digest alone. */
export function mintToken(): string {
  return randomBytes(24).toString('base64url')
}

/** How a workspace token is stored (the workspace-model brief, item 1): its sha256, in hex. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The digest of the bearer token a header presents, or of nothing at all, so a missing header costs what a wrong one does. */
export function bearerDigest(authorization: string | undefined): string {
  return tokenDigest(authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '')
}

/** Two digests compared in constant time. */
export function digestMatches(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}
