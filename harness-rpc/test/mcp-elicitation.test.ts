import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, InvokeResponse } from '@5straps/protocol'
import { createToolRegistry } from '../src/domain/tool-registry.js'
import { createMcpServer } from '../src/faces/mcp/server.js'
import type { BuckleRuntime } from '../src/runtime.js'

const approval: ApprovalRequest = {
  token: 'token-1',
  rule: 'read_scope',
  subject: '/etc/hostname',
  reason: 'reads outside the workspace',
  tool: 'gated_tool',
  offeredScopes: ['once', 'session'],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
}

const gatedResponse: InvokeResponse = { requestId: 'request-1', outcome: 'approval_required', approvals: [approval] }

function gatedServer(): McpServer {
  const registry = createToolRegistry([{
    capability: {
      name: 'gated_tool',
      description: 'Always answers with an approval request',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: [],
      pack: 'test',
    },
    inputSchema: z.object({}),
    prepare: () => ({ effects: [], execute: async () => null }),
  }])
  const runtime = {
    registry: () => registry,
    skills: () => [],
    onToolsChanged: () => undefined,
    invoke: async () => gatedResponse,
  } as unknown as BuckleRuntime

  return createMcpServer({ runtime, serverName: 'buckle-test', version: '0.0.0', trustedApprovalResponses: true })
}

/** The handler the server registered, which is where the elicitation branch is chosen. */
function gatedCall(server: McpServer, context: ServerContext) {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<unknown> }> })._registeredTools
  return tools['gated_tool']!.handler({}, context)
}

/** A context in the shape the protocol layer builds, minus everything the handler never reads. */
function stubContext(input: { envelope?: Record<string, unknown> }): ServerContext {
  return {
    sessionId: 'unit',
    mcpReq: { id: 1, method: 'tools/call', requestState: () => undefined, ...input.envelope ? { envelope: input.envelope } : {} },
  } as unknown as ServerContext
}

describe('MCP elicitation detection', () => {
  it('elicits when a 2026-07-28 client declares elicitation in the request envelope', async () => {
    const result = await gatedCall(gatedServer(), stubContext({
      envelope: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } },
    }))
    expect(result).toMatchObject({ resultType: 'input_required' })
    expect(Object.keys((result as { inputRequests: Record<string, unknown> }).inputRequests)).toEqual(['token-1'])
  })

  it('elicits when a 2025 era client declared elicitation during initialize', async () => {
    const server = gatedServer()
    // The handshake the SDK runs for a 2025 era connection, which is where those capabilities land.
    await (server.server as unknown as { _oninitialize: (request: unknown) => Promise<unknown> })._oninitialize({
      params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'legacy', version: '0.0.0' } },
    })
    expect(await gatedCall(server, stubContext({}))).toMatchObject({ resultType: 'input_required' })
  })

  it('relays the approval as text when the client declares no elicitation', async () => {
    const result = await gatedCall(gatedServer(), stubContext({
      envelope: { [CLIENT_CAPABILITIES_META_KEY]: { roots: {} } },
    }))
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain('buckle approve token-1 --scope session')
  })

  it('relays the approval as text when the client declares URL elicitation alone', async () => {
    const result = await gatedCall(gatedServer(), stubContext({
      envelope: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } } },
    }))
    expect(result).toMatchObject({ isError: true })
  })
})
