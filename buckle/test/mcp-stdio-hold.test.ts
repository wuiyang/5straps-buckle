import type { ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../common/domain/tool-registry.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { MCP_HOLD_MS, mcpWait, workspaceWait } from '../mcp/holds.js'
import { createStdioServer } from '../mcp/stdio.js'

// The MCP asks brief, item 1, and the review of that slice (finding minor-8): the HTTP face holds a call for the
// workspace's wait at most MCP_HOLD_MS, and the stdio face keeps the workspace's own wait, which a host that is not
// elicited needs to be as long as the owner set it.

describe('the wait each MCP face gives a call', () => {
  it('reads the workspace\'s own wait on stdio, uncapped, and 0 as until decided; HTTP caps it', () => {
    expect(workspaceWait(600_000)).toEqual({ mode: 'finite', ms: 600_000 })
    expect(workspaceWait(15_000)).toEqual({ mode: 'finite', ms: 15_000 })
    expect(workspaceWait(null)).toBeUndefined()
    expect(mcpWait(600_000)).toEqual({ mode: 'finite', ms: MCP_HOLD_MS })
    expect(mcpWait(null)).toEqual({ mode: 'finite', ms: MCP_HOLD_MS })
  })
})

function stdioCall(approvalTimeoutMs: number | null) {
  const registry = createToolRegistry([{
    capability: { name: 'held_tool', description: 'Needs a person', inputSchema: { type: 'object', properties: {} }, risk: 'read', tags: [], pack: 'test' },
    inputSchema: z.object({}),
    prepare: () => ({ effects: [], execute: async () => null }),
  }])
  const invoke = vi.fn(async (_input: Record<string, unknown>) => ({ requestId: 'r', outcome: 'ok' as const, output: null, meta: { durationMs: 0, truncated: false } }))
  const runtime = {
    registry: () => registry, manifest: () => ({ tools: registry.capabilities(), version: '0.0.0' }), skills: () => [], onToolsChanged: () => undefined,
    openApprovalForms: () => undefined, approvalForms: () => false, invoke,
  } as unknown as BuckleRuntime
  const server = createStdioServer({ runtime, config: { serverName: 'stdio-test', serverId: 'node-1', approvalTimeoutMs }, callScope: run => run(), beforeCall: async () => undefined })
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<unknown> }> })._registeredTools
  const context = { sessionId: 'stdio-1', mcpReq: { id: 1, method: 'tools/call', requestState: () => undefined } } as unknown as ServerContext
  return { invoke, call: () => tools['held_tool']!.handler({}, context) as Promise<unknown> }
}

describe('the stdio face', () => {
  it.each([[600_000, { mode: 'finite', ms: 600_000 }], [15_000, { mode: 'finite', ms: 15_000 }]] as const)('gives a call at workspace wait %s the workspace\'s own wait, past the HTTP cap', async (wait, given) => {
    const { invoke, call } = stdioCall(wait)
    await call()
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ approvalWait: given }))
  })

  it('gives a call at workspace wait 0 no wait of its own, so it is held until decided', async () => {
    const { invoke, call } = stdioCall(null)
    await call()
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0]![0]).not.toHaveProperty('approvalWait')
  })
})

