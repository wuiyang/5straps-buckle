import { requireAgent } from '../../../utils/guards.js'
import { health } from '../../../utils/health.js'
import { defineOperationHandler } from '../../../utils/operation.js'
import { useTarget } from '../../../utils/target.js'

// A workspace's liveness answers its agent credential only, unlike the node's open /health.
export default defineOperationHandler({
  guards: [requireAgent()],
  handler: async (event) => {
    await useTarget(event)
    return health(event)
  },
})
