import { defineMiddleware } from 'h3'
import { bearerToken } from '../../../common/server/utils/guards.js'

// Scanned middleware is global. This one only labels MCP-looking traffic; guards never read the label (F24, F25).
// Only while the runtime is ready: during startup or shutdown the route's own guard answers 503.
export default defineMiddleware(async (event) => {
  if (!event.req.headers.has('mcp-protocol-version') || event.context.runtime?.state !== 'ready') return
  try {
    const actor = (await event.context.services?.getAccess())?.verify('agent', bearerToken(event))
    if (actor) event.context.mcpActor = actor
  } catch (error) {
    event.context.logger?.debug('mcp client label skipped', { error })
  }
})
