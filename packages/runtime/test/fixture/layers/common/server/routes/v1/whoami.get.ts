import { setTimeout as delay } from 'node:timers/promises'
import { useScope } from '@5straps/runtime'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { requireAgent, useServices } from '../../utils/guards.js'

// F19: identity read through three paths after an await; any crossover shows as a mismatch.
export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event, scope) => {
    const services = useServices(event)
    const operation = await services.getOperation()
    await delay(Math.floor(Math.random() * 20))
    const [first, second] = await Promise.all([services.createProbe(), services.createProbe()])
    return {
      actor: scope.context.actor,
      alsActor: useScope().context.actor,
      serviceActor: operation.actor,
      sameScopedInstance: operation === await services.getOperation(),
      freshTransients: first.id !== second.id,
      correlationId: scope.context.correlationId,
      serial: operation.record('whoami'),
    }
  },
})
