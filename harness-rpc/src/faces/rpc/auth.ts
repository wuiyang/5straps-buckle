import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

/** Constant-time comparison, so a wrong token leaks nothing through response timing. */
export function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  const expectedBuffer = Buffer.from(expected)
  if (supplied.byteLength !== expectedBuffer.byteLength) return false
  return timingSafeEqual(supplied, expectedBuffer)
}

/**
 * The one bearer gate. Every route that exposes the tool registry mounts this, native RPC and
 * MCP alike, so a face cannot be added over HTTP without inheriting the check.
 */
export function requireBearerToken(expected: string): MiddlewareHandler {
  return async (context, next) => {
    if (!tokenMatches(context.req.header('authorization'), expected)) {
      return context.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
}
