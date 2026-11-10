import { McpServer } from '@modelcontextprotocol/server'
import { withOperationScope, type OperationScope, type RequestCli } from '@5straps/runtime'
import * as z from 'zod/v4'
import { askOwner } from '../common/interaction.js'
import type { FixtureServices } from '../common/types.js'

export interface McpDependencies {
  services: FixtureServices
  // Injected by main (stdio) or taken from the HTTP request context; mcp/ never imports Nitro (F12).
  requestCli: RequestCli
  version: string
  // Stdio calls enter their own operation scope; over HTTP the request scope is already active.
  openScope?: () => OperationScope
}

const askInput = z.object({
  summary: z.string().min(1).max(200),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
})

export function createFixtureMcpServer(deps: McpDependencies): McpServer {
  const server = new McpServer({ name: 'runtime-fixture', version: deps.version })
  const inScope = <T>(operation: () => Promise<T>): Promise<T> => deps.openScope ? withOperationScope(deps.openScope(), operation) : operation()

  server.registerTool('list_notes', { description: 'List every note' }, () => inScope(async () => {
    const notes = await (await deps.services.getNotes()).list()
    return { content: [{ type: 'text' as const, text: JSON.stringify(notes) }] }
  }))

  server.registerTool('ask_owner', { description: 'Ask the owner at the local terminal', inputSchema: askInput }, ({ summary, timeoutMs }, context) => inScope(async () => {
    const outcome = await askOwner({ summary, timeoutMs, requestCli: deps.requestCli, approvals: await deps.services.getApprovals(), signal: context.mcpReq.signal })
    return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] }
  }))
  return server
}
