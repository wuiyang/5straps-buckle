import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import type { NitroApp } from 'nitro/types'
import type { BuckleCommon } from '../../common/runtime/initialize.js'
import { notReadyResponse, operationScopes, type ScopeEnv } from './operation-scope.js'

/**
 * Temporary, B13 to B17 (Buckle phase plan, section F): the face still on Hono until its layer moves,
 * the owner's setup face (B17), at node level and under /workspaces/[id]/. Every other path is the
 * Nitro layers', so each route has exactly one implementation at every commit. B18 deletes this file
 * with Hono.
 */
function honoFace(face: readonly string[]): boolean {
  return face[0] === 'setup'
}

// Escapes of characters a path segment may carry as they are: h3 decodes exactly these before it
// routes (h3 2.0.1-rc.32, NEEDLESS_ESCAPE in dist/response.mjs), while %2F, %25, %3F and %5C stay encoded.
const NEEDLESS_ESCAPE = /%(?:2[146-9A-E]|3[0-9ABD]|4[0-9A-F]|5[0-9ABDF]|6[1-9A-F]|7[0-9ACE])/gi

/**
 * The path ownership is decided on (review M1 of B13-B14): needless escapes decoded as h3 decodes
 * them, duplicate slashes collapsed and a trailing slash dropped; case is kept, as both routers keep
 * it. Dot segments are already resolved by the URL parser. An alias such as `/%68ealth` or
 * `/health/` therefore goes where `/health` goes, so no spelling reaches the other router's copy of a
 * route that has moved.
 */
export function canonicalPath(pathname: string): string {
  const decoded = pathname.replace(NEEDLESS_ESCAPE, escape => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
  const collapsed = decoded.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

export function nitroOwns(pathname: string): boolean {
  const segments = canonicalPath(pathname).split('/').slice(1)
  // /workspaces/[id]/<face> is the same face for one workspace.
  const face = segments[0] === 'workspaces' && segments.length > 2 ? segments.slice(2) : segments
  return !honoFace(face)
}

export interface Dispatcher {
  /** The one request path, for the node server and the test harness alike. */
  fetch(request: Request, env?: HttpBindings): Response | Promise<Response>
  /** Serves the Hono faces once the common runtime is ready; until then their paths answer 503. */
  mount(app: Hono): void
}

export function createDispatcher(input: { common: BuckleCommon; nitroApp: NitroApp }): Dispatcher {
  let hono: Hono<ScopeEnv> | undefined
  return {
    fetch: (request, env) => {
      if (nitroOwns(new URL(request.url).pathname)) return input.nitroApp.fetch(request)
      return hono ? hono.fetch(request, env) : notReadyResponse()
    },
    mount(app) {
      const scoped = new Hono<ScopeEnv>()
      // Any route may answer while an HTTP call is held, so it waits for the grace period.
      scoped.use('*', operationScopes(input.common, 'grace'))
      scoped.route('/', app)
      hono = scoped
    },
  }
}
