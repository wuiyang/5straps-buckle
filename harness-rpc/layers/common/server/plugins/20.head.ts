import type { H3Event } from 'h3'
import { definePlugin } from 'nitro'

/**
 * HEAD answers as GET does, headers only (RFC 9110, 9.3.2), on every route file that serves GET: the
 * compiled router registers no HEAD entry, so HEAD used to fall to a catch-all or the router's 404
 * (review L1 of B15-B17). A route that serves every method (the MCP route, the catch-alls) still sees
 * HEAD itself when no GET route matches. The GET route's guards run as they do for GET; only the
 * method name differs, so an admin route audits it as setup_head_<resource>.
 */
export default definePlugin((nitroApp) => {
  const app = nitroApp.h3
  if (!app) return
  const findRoute = app['~findRoute'].bind(app)
  app['~findRoute'] = (event) => {
    if (event.req.method !== 'HEAD') return findRoute(event)
    const get = findRoute(asGet(event))
    return get && get.data.method?.toUpperCase() === 'GET' ? get : findRoute(event)
  }
})

// The router reads the method and the path only; the probe carries the request's own URL and context.
function asGet(event: H3Event): H3Event {
  return { req: { method: 'GET' }, url: event.url, context: event.context } as unknown as H3Event
}
