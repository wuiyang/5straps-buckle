import type { NitroApp } from 'nitro/types'

/**
 * Temporary, B13 to B18 (Buckle phase plan, section F). Since B17 no face is left on Hono: every path
 * is the Nitro layers', including every spelling of it, so each route has exactly one implementation.
 * serve.ts still listens through @hono/node-server; B18 replaces both with the built middleware.
 */
export interface Dispatcher {
  /** The one request path, for the node server and the test harness alike. */
  fetch(request: Request): Response | Promise<Response>
}

export function createDispatcher(input: { nitroApp: NitroApp }): Dispatcher {
  return { fetch: request => input.nitroApp.fetch(request) }
}
