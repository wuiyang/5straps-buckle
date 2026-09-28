import type { H3Event } from 'h3'
import { defineGuardedHandler, type Guard } from '@5straps/runtime/nitro'
import type { OperationScope } from '@5straps/runtime'
import { useServices } from './services.js'

/**
 * A Buckle HTTP operation: readiness and the route's guards, then its own operation scope with the
 * HTTP hold bound, so a gated call is held for the grace period while any route may answer. The
 * requester stays the process's (common/services/approvals/interaction.ts); only the hold is scoped.
 */
export function defineOperationHandler<T>(definition: { guards: readonly Guard[]; handler: (event: H3Event, scope: OperationScope) => T | Promise<T> }) {
  return defineGuardedHandler({
    guards: definition.guards,
    handler: async (event, scope) => {
      (await useServices(event).getInteraction(scope)).bind('grace')
      return definition.handler(event, scope)
    },
  })
}
