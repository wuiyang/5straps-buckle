import type { H3Event } from 'h3'
import { definePlugin } from 'nitro'

/**
 * HEAD answers as GET does, headers only (RFC 9110, 9.3.2), on every route file that serves GET: the
 * compiled router registers no HEAD entry, so HEAD used to fall to a catch-all or the router's 404
 * (review L1 of B15-B17). A route that serves every method (the MCP route, the catch-alls) still sees
 * HEAD itself when no GET route matches. The GET route's guards run as they do for GET; only the
 * method name differs, so an admin route audits it as setup_head_<resource>.
 *
 * Every route's data (its route, method and handler) is locked as the router hands it out, before its
 * handler runs, so no code can swap a guarded handler, or add middleware in front of it, for later
 * requests: an assignment throws (review item 21 of the proof-of-possession fixes; L7 of B23-B25).
 */
export default definePlugin((nitroApp) => {
  const app = nitroApp.h3
  // A Nitro or h3 bump that renames either fails the start, never HEAD silently (review L12 of B18-B19; plan risk 7).
  if (!app || typeof app['~findRoute'] !== 'function') throw new Error('Buckle serves HEAD through the h3 app\'s ~findRoute, which this Nitro build does not have; re-verify 20.head.ts against the pinned nitro and h3')
  const findRoute = app['~findRoute'].bind(app)
  const frozen: typeof findRoute = (event) => {
    const match = findRoute(event)
    if (match) lock(match.data as unknown as Record<string, unknown>)
    return match
  }
  app['~findRoute'] = (event) => {
    if (event.req.method !== 'HEAD') return frozen(event)
    const get = frozen(asGet(event))
    return get && get.data.method?.toUpperCase() === 'GET' ? get : frozen(event)
  }
})

/**
 * A route without middleware is frozen whole. h3 caches a route's composed middleware on its data
 * (`~composed`), so a route with middleware keeps that one write and has its handler and middleware
 * locked instead.
 */
function lock(data: Record<string, unknown>): void {
  if (!(data.middleware as unknown[] | undefined)?.length) {
    Object.freeze(data)
    return
  }
  for (const name of ['handler', 'middleware']) Object.defineProperty(data, name, { writable: false, configurable: false })
}

// The router reads the method and the path only; the probe carries the request's own URL and context.
function asGet(event: H3Event): H3Event {
  return { req: { method: 'GET' }, url: event.url, context: event.context } as unknown as H3Event
}
