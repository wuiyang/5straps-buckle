import { createMcpHandler } from '@modelcontextprotocol/server'
import type { ManagedWorkspace } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { McpHttpHandlers } from '../common/types/ports/mcp-http.js'
import { mcpWait } from './holds.js'
import { createMcpServer } from './server.js'

type SdkHandler = ReturnType<typeof createMcpHandler>

/**
 * One stateless SDK handler per workspace runtime, created on its first request and kept while the
 * runtime lives. The SDK builds a server per request; the handler outlives them, so it is the one
 * that tells subscribed streams the tool list changed. Over HTTP the request's operation is already
 * open (layers/mcp), so tool calls run inside it and ask through its bound hold, which ends by MCP_HOLD_MS at the latest.
 */
export function createMcpHttpHandlers(): McpHttpHandlers {
  const handlers = new WeakMap<BuckleRuntime, SdkHandler>()
  const open = new Set<SdkHandler>()
  const handlerFor = ({ config, runtime }: ManagedWorkspace): SdkHandler => {
    const existing = handlers.get(runtime)
    if (existing) return existing
    // A per-request server answers one request, so it does not follow tool changes itself.
    // The workspace's wait is read at each call, so a change to it applies from the next one, and at most MCP_HOLD_MS.
    const handler = createMcpHandler(() => createMcpServer({ runtime, serverName: config.serverName, serverId: config.serverId, version: runtime.manifest().version, followToolChanges: false, approvalWait: () => mcpWait(config.approvalTimeoutMs) }))
    runtime.onToolsChanged(() => handler.notify.toolsChanged())
    handlers.set(runtime, handler)
    open.add(handler)
    return handler
  }
  return {
    fetch: async (workspace, request) => allowPostOnly(await handlerFor(workspace).fetch(request)),
    async close() {
      for (const handler of open) await handler.close()
      open.clear()
    },
  }
}

// The stateless SDK answers other methods with 405 but no Allow header; RFC 9110 requires one, and only POST is served.
export function allowPostOnly(response: Response): Response {
  if (response.status !== 405 || response.headers.has('allow')) return response
  const headers = new Headers(response.headers)
  headers.set('allow', 'POST')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
