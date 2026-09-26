import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { useServices } from '../../../../common/server/utils/guards.js'
import { requireAdmin } from '../../utils/guards.js'

export default defineGuardedHandler({
  guards: [requireAdmin],
  handler: async (event) => {
    const serial = (await useServices(event).getOperation()).record('setup.status')
    return { layer: 'admin', serial }
  },
})
