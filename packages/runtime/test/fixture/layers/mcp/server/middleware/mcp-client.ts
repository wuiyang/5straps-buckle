import { defineMiddleware } from 'h3'
import { bearerToken } from '../../../common/server/utils/guards.js'

// Scanned middleware is global. This one only labels MCP-looking traffic; guards never read the label (F24, F25).
export default defineMiddleware(async (event) => {
  if (!event.req.headers.has('mcp-protocol-version')) return
  const access = await event.context.services?.getAccess()
  const actor = access?.verify('agent', bearerToken(event))
  if (actor) event.context.mcpActor = actor
})
