import { nodeActions } from '../../utils/audit.js'
import { notFound } from '../../utils/errors.js'
import { requireAgent } from '../../utils/guards.js'
import { INVOKE_REFUSED, isInvokePath, recordInvokeRefusal } from '../../utils/invoke.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { NODE_LEVEL, useTarget } from '../../utils/target.js'

// Every other /v1 path and method: the agent credential first, so an unauthenticated probe learns
// nothing, then 404. A method other than POST on /v1/invoke is refused and audited as the invoke
// face refuses anything before the invoker sees it (review L2 of B15-B17).
export default defineOperationHandler({
  guards: [event => requireAgent(isInvokePath(event) ? INVOKE_REFUSED : undefined)(event)],
  handler: async (event) => {
    if (isInvokePath(event)) {
      // The guard has let the credential in, so the workspace is known on this route and on its /workspaces/ twin alike: the
      // refusal is that workspace's, in its own log. A workspace that will not open leaves it to the node's (fix brief 4, finding 39).
      const target = await useTarget(event).catch(() => null)
      if (target) recordInvokeRefusal(target.runtime.actions, target.runtime.workspaceId, 404)
      else recordInvokeRefusal(await nodeActions(event), NODE_LEVEL, 404)
    }
    throw notFound()
  },
})
