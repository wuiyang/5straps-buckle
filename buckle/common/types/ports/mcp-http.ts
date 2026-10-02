import type { BuckleServices } from '../../runtime/services.js'
import type { ManagedWorkspace } from '../../services/workspaces/workspace-manager.js'

/**
 * The MCP face over HTTP: one SDK handler per open workspace runtime, kept for the process, which
 * relays the tools-changed notice to subscribed streams. Built by the server setup (mcp/http.ts), so
 * common code never imports the MCP layer.
 */
export interface McpHttpHandlers {
  /** Serves one buffered MCP request for the workspace; other methods than POST answer 405 with Allow. */
  fetch(workspace: ManagedWorkspace, request: Request): Promise<Response>
  /** Ends in-flight exchanges; called at the owner's 'streams' stage. */
  close(): Promise<void>
}

/** The services the Nitro layers read: the common ones, and the MCP handlers the server setup adds. */
export interface BuckleHttpServices extends BuckleServices {
  getMcpHandlers(): McpHttpHandlers
}
