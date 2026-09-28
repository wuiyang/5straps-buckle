import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import type { NitroApp } from 'nitro/types'
import type { BuckleCommon } from '../../common/runtime/initialize.js'
import { notReadyResponse, operationScopes, type ScopeEnv } from './operation-scope.js'

/**
 * Temporary, B13 to B17 (Buckle phase plan, section F): the paths the Nitro layers already serve.
 * Every other path stays on the Hono faces until its layer moves, so each route has exactly one
 * implementation at every commit. B18 deletes this file with Hono.
 */
const NITRO_PATHS: ReadonlySet<string> = new Set(['/health', '/health/ready'])

export function nitroOwns(pathname: string): boolean {
  return NITRO_PATHS.has(pathname)
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
