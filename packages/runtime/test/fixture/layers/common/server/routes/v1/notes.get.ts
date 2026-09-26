import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { requireAgent, useServices } from '../../utils/guards.js'

export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event) => {
    const services = useServices(event)
    ;(await services.getOperation()).record('notes.list')
    return { notes: await (await services.getNotes()).list() }
  },
})
