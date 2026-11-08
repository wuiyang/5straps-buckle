import { createOperationScope, runInScope } from '@5straps/runtime'
import type { ElicitRequestFormParams } from '@modelcontextprotocol/client'
import type { ManagedWorkspace } from '../../common/services/workspaces/workspace-manager.js'
import type { McpHttpHandlers } from '../../common/types/ports/mcp-http.js'
import { CLAUDE_CODE_HTTP_MCP } from './claude-code-http-mcp.js'

export type Form = ElicitRequestFormParams
export interface HttpToolResult { isError?: boolean; resultType?: string; inputRequests?: Record<string, { params?: Form }>; content?: Array<{ type: string; text: string }>; structuredContent?: { outcome?: string } }

const owner = Symbol('mcp-http-call')

/** Runs `run` as the transport authenticated `actor`, as the agent guard opens each /mcp request's operation. */
export function asCaller<T>(actor: string, run: () => Promise<T>): Promise<T> {
  return runInScope(createOperationScope({ owner, context: { actor } }), run)
}

/** A tools/call as Claude Code sends one at 2026-07-28: the headers and `_meta` envelope its recorded tools/list carried. */
export function claudeCodeCall(input: { tool: string; args: Record<string, unknown>; responses?: Record<string, unknown> }): Request {
  const { headers, body } = CLAUDE_CODE_HTTP_MCP.modern.toolsList
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: { ...headers, 'mcp-method': 'tools/call', 'mcp-name': input.tool },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: input.tool, arguments: input.args, _meta: body.params._meta, ...(input.responses ? { inputResponses: input.responses } : {}) } }),
  })
}

/** One request through the HTTP face's own handler as `actor`, and the tool result it answers, as JSON or an event stream. */
export async function sendAs(input: { handlers: McpHttpHandlers; workspace: ManagedWorkspace; request: Request; actor: string }): Promise<HttpToolResult> {
  const response = await asCaller(input.actor, () => input.handlers.fetch(input.workspace, input.request))
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)) as { result?: HttpToolResult }).find(message => message.result)
    : JSON.parse(text) as { result?: HttpToolResult }
  if (!json?.result) throw new Error(`No tool result in ${text}`)
  return json.result
}

export function formOf(result: HttpToolResult, key: string): Form {
  const shown = result.inputRequests?.[key]?.params
  if (!shown) throw new Error(`No form for ${key} in ${JSON.stringify(result)}`)
  return shown
}
