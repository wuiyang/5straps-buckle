import { timingSafeEqual } from 'node:crypto'

/** Constant-time comparison, so a wrong token leaks nothing through response timing. */
export function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  const expectedBuffer = Buffer.from(expected)
  if (supplied.byteLength !== expectedBuffer.byteLength) return false
  return timingSafeEqual(supplied, expectedBuffer)
}

/**
 * A workspace holds several agent tokens, each revocable, so a gate takes either one fixed
 * credential or a function read per request: a token revoked a moment ago must be refused by a
 * face mounted long before.
 */
export type TokenSource = string | (() => string[])

export function matchesTokenSource(authorization: string | undefined, expected: TokenSource): boolean {
  const candidates = typeof expected === 'string' ? [expected] : expected()
  return candidates.some(candidate => Boolean(candidate) && tokenMatches(authorization, candidate))
}
