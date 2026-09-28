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
  // A Nitro or h3 bump that renames either fails the start, never HEAD silently (review L12 of B18-B19; plan risk 7).
  if (!app || typeof app['~findRoute'] !== 'function') throw new Error('Buckle serves HEAD through the h3 app\'s ~findRoute, which this Nitro build does not have; re-verify 20.head.ts against the pinned nitro and h3')
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
