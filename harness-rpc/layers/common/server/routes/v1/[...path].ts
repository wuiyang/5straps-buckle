import { notFound } from '../../utils/errors.js'
import { requireAgent } from '../../utils/guards.js'
import { defineOperationHandler } from '../../utils/operation.js'

// Every other /v1 path and method: the agent credential first, so an unauthenticated probe learns
// nothing, then 404.
export default defineOperationHandler({
  guards: [requireAgent()],
  handler: () => { throw notFound() },
})
