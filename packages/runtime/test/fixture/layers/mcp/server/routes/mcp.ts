import { HTTPError } from 'h3'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { createFixtureMcpServer } from '../../../../mcp/server.js'
import { requireAgent, useServices } from '../../../common/server/utils/guards.js'

// Transport adapter only: auth here, protocol in mcp/. The SDK reads the body exactly once (F25).
export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event) => {
    const services = useServices(event)
    const requestCli = event.context.requestCli
    if (!requestCli) throw HTTPError.status(503, 'Service Unavailable', { message: 'CLI interaction is not attached' })
    ;(await services.getOperation()).record('mcp.request')
    const handler = createMcpHandler(() => createFixtureMcpServer({ services, requestCli, version: '0.0.0' }))
    return handler.fetch(event.req)
  },
})
