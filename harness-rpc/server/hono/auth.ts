import type { MiddlewareHandler } from 'hono'
import { matchesTokenSource, type TokenSource } from '../../common/services/access/tokens.js'

/**
 * The one bearer gate. Every route that exposes the tool registry mounts this, native RPC and
 * MCP alike, so a face cannot be added over HTTP without inheriting the check.
 */
export function requireBearerToken(expected: TokenSource): MiddlewareHandler {
  return async (context, next) => {
    if (!matchesTokenSource(context.req.header('authorization'), expected)) {
      return context.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
}
