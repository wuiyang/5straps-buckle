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
 * handler runs, so no code can swap a guarded handler for later requests: an assignment throws (review
 * item 21 of the proof-of-possession fixes; L7 of B23-B25). The app is locked too (lockApp).
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
  lockApp(app as unknown as Record<string, unknown> & { config: object })
})

/**
 * The app, once its router wrapper is in place, is fixed for every later request (review L11 of the
 * second proof-of-possession re-review): its config, which holds the request, response and error
 * hooks h3 calls, is frozen and fixed on the app; every method it runs, its own and those its classes
 * give it, is fixed on the app itself, so a wrapper on the shared h3 prototype never reaches it; and
 * its middleware and route lists are frozen. h3's lazy dispatcher and composed middleware are fields,
 * not methods, and stay as h3 and Nitro set them. The prototype itself is left alone: other apps in
 * the process share it.
 */
function lockApp(app: Record<string, unknown> & { config: object }): void {
  Object.freeze(app.config)
  Object.defineProperty(app, 'config', { writable: false, configurable: false })
  for (const name of methodNames(app)) {
    const own = Object.getOwnPropertyDescriptor(app, name)
    Object.defineProperty(app, name, { value: own && 'value' in own ? own.value : app[name], writable: false, configurable: false, enumerable: own?.enumerable ?? false })
  }
  for (const value of Object.values(app)) if (Array.isArray(value)) Object.freeze(value)
}

/** The methods the app's classes define, nearest first; getters and the constructor are not methods. */
function methodNames(app: object): Set<string> {
  const names = new Set<string>()
  for (let prototype = Object.getPrototypeOf(app) as object | null; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype) as object | null) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === 'function') names.add(name)
    }
  }
  return names
}

/**
 * A route is frozen whole. No Buckle route carries middleware, and h3 caches a route's composed
 * middleware on its data, which a frozen route cannot hold, so one that carries middleware is
 * refused rather than half locked (ruling 2 of 2026-09-28: fail closed; review L12 of the second
 * re-review). Lock it here before adding a route with middleware.
 */
function lock(data: Record<string, unknown>): void {
  if ((data.middleware as unknown[] | undefined)?.length) throw new Error('A route with middleware reached Buckle\'s router, which locks only routes without it; 20.head.ts refuses to serve it')
  Object.freeze(data)
}

// The router reads the method and the path only; the probe carries the request's own URL and context.
function asGet(event: H3Event): H3Event {
  return { req: { method: 'GET' }, url: event.url, context: event.context } as unknown as H3Event
}
