import { createOperationScope, runInScope } from '@5straps/runtime'
import type { JsonObject } from '@5straps/protocol'
import { CLIENT_CAPABILITIES_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { CLAUDE_CODE_CAPABILITIES } from './claude-code-http-mcp.js'

export interface HostToolResult { isError?: boolean; resultType?: string; inputRequests?: Record<string, unknown>; structuredContent?: { outcome?: string } }

/** One call: a retry's answers and `_meta` where it carries them, run as the transport's `actor` where one is named. */
export interface HostCall { args: JsonObject; responses?: Record<string, unknown>; meta?: Record<string, unknown>; actor?: string }

const owner = Symbol('mcp-host-tool')

/** A tool the server registered, called as a host that declares form elicitation calls it, as Claude Code does. */
export function hostTool(server: McpServer, tool: string): (call: HostCall) => Promise<HostToolResult> {
  // The SDK keeps no public handle on a registered tool's handler.
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<HostToolResult> }> })._registeredTools
  const envelope = { [CLIENT_CAPABILITIES_META_KEY]: CLAUDE_CODE_CAPABILITIES }
  return (call) => {
    const request = { id: 1, method: 'tools/call', requestState: () => undefined, envelope, ...(call.meta ? { _meta: call.meta } : {}), ...(call.responses ? { inputResponses: call.responses } : {}) }
    const run = () => tools[tool]!.handler(call.args, { mcpReq: request } as unknown as ServerContext)
    return call.actor === undefined ? run() : runInScope(createOperationScope({ owner, context: { actor: call.actor } }), run)
  }
}
