import { nodeActions, tolerantLog } from '../../utils/audit.js'
import { notFound } from '../../utils/errors.js'
import { requireAgent } from '../../utils/guards.js'
import { INVOKE_REFUSED, isInvokePath, recordInvokeRefusal } from '../../utils/invoke.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { NODE_LEVEL, namedWorkspace, useTarget } from '../../utils/target.js'

// Every other /v1 path and method: the agent credential first, so an unauthenticated probe learns
// nothing, then 404. A method other than POST on /v1/invoke is refused and audited as the invoke
// face refuses anything before the invoker sees it (review L2 of B15-B17).
export default defineOperationHandler({
  guards: [event => requireAgent(isInvokePath(event) ? INVOKE_REFUSED : undefined)(event)],
  handler: async (event) => {
    if (isInvokePath(event)) {
      if (namedWorkspace(event)) {
        const { runtime } = await useTarget(event)
        await recordInvokeRefusal(tolerantLog(event, runtime.actions), runtime.workspaceId, 404)
      } else {
        await recordInvokeRefusal(tolerantLog(event, await nodeActions(event)), NODE_LEVEL, 404)
      }
    }
    throw notFound()
  },
})
