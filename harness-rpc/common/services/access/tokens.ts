import { timingSafeEqual } from 'node:crypto'

/** Constant-time comparison, so a wrong token leaks nothing through response timing. */
export function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  const expectedBuffer = Buffer.from(expected)
  if (supplied.byteLength !== expectedBuffer.byteLength) return false
  return timingSafeEqual(supplied, expectedBuffer)
}
