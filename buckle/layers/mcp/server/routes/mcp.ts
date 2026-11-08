import type { H3Event } from 'h3'
import { recordTransportRefusal, withTransportAudit } from '../../../common/server/utils/audit.js'
import { readBody } from '../../../common/server/utils/body.js'
import { mapAgentFailures } from '../../../common/server/utils/errors.js'
import { isMutation, requireAgent, type RefusalAudit } from '../../../common/server/utils/guards.js'
import { defineOperationHandler } from '../../../common/server/utils/operation.js'
import { useServices } from '../../../common/server/utils/services.js'
import { NODE_LEVEL, useTarget } from '../../../common/server/utils/target.js'

/** At node level the transport audit took in the credential check; under a workspace the node's log names the face. */
const MCP_REFUSED: RefusalAudit = {
  node: ({ event, actions, status }) => recordTransportRefusal(actions, { tool: transportTool(event), workspaceId: NODE_LEVEL, status }),
  named: 'workspace_mcp_auth_rejected',
}

// Transport adapter only: the agent guard, the body limit, then the SDK over a buffered request, with
// the protocol in mcp/ (plan section B, route mapping). Tool calls run in this request's operation.
export default defineOperationHandler({
  guards: [requireAgent(MCP_REFUSED)],
  handler: async (event) => {
    const workspace = await useTarget(event)
    const { config, runtime } = workspace
    return mapAgentFailures(() => withTransportAudit(runtime.actions, { tool: transportTool(event), workspaceId: runtime.workspaceId, required: isMutation(event) }, async () => {
      const request = await bufferedRequest(event, config.maxRequestBytes)
      return useServices(event).getMcpHandlers().fetch(workspace, request)
    }))
  },
})

function transportTool(event: H3Event): string {
  return `http_mcp_${event.req.method.toLowerCase()}`
}

async function bufferedRequest(event: H3Event, limit: number): Promise<Request> {
  // The SDK gets the body buffered, so the wire's length or chunked encoding would be wrong for it.
  // The guard has read the credential; nothing past it needs the agent's token (review L9 of B15-B17).
  const headers = new Headers(event.req.headers)
  for (const name of ['content-length', 'transfer-encoding', 'authorization']) headers.delete(name)
  const body = isMutation(event) ? await readBody(event, limit) : undefined
  return new Request(event.req.url, { method: event.req.method, headers, signal: event.req.signal, ...(body ? { body } : {}) })
}
