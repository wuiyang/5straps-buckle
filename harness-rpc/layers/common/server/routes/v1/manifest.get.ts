import { requireAgent } from '../../utils/guards.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { useTarget } from '../../utils/target.js'

export default defineOperationHandler({
  guards: [requireAgent()],
  handler: async event => (await useTarget(event)).runtime.manifest(),
})
