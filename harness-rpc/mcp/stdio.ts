import { SdkErrorCode } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { withOperationScope, type Logger } from '@5straps/runtime'
import type { BuckleConfig } from '../common/runtime/config.js'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import { createAuditedStdioTransport } from './audited-stdio-transport.js'
import { createMcpServer, type ToolCallScope } from './server.js'
import { createStdioWire } from './stdio-wire.js'

/** stdout carries the MCP protocol here, so every log line must go to stderr. */
export async function serveMcpStdio(input: { config: BuckleConfig; common: BuckleCommon; logger: Logger }): Promise<void> {
  const { config, common } = input
  await common.start()
  const runtime = await common.services.getWorkspaceRuntime()
  const version = runtime.manifest().version
  const transport = createAuditedStdioTransport({
    transport: createStdioWire({ stdin: process.stdin, stdout: process.stdout, maxBufferBytes: config.maxRequestBytes }),
    actions: runtime.actions, workspaceId: runtime.workspaceId, isKnownTool: name => runtime.registry().has(name),
  })
  const callScope = stdioCallScope(common)
  const stdio = serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, version, trustedApprovalResponses: true, callScope, isCancel: isExplicitCancel }), { transport })
  common.owner.onClose('accept', 'mcp stdio', () => stdio.close())
  input.logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, tools: runtime.registry().capabilities().length })
}

/**
 * On stdio the SDK aborts a call with the client's own reason on notifications/cancelled, and with its
 * connection-closed error when stdin ends: only the first is a cancel. Over HTTP the two cannot be
 * told apart, so the HTTP face passes no such test and every abort keeps the asks.
 */
export function isExplicitCancel(reason: unknown): boolean {
  return !(reason instanceof Error && (reason as { code?: unknown }).code === SdkErrorCode.ConnectionClosed)
}

/**
 * Each tool call is its own operation (nitro/runtime.md, Asynchronous context), asking through the
 * requester main bound. A gated call is held for the grace period, as over HTTP.
 */
export function stdioCallScope(common: BuckleCommon): ToolCallScope {
  return (run, context) => {
    const scope = common.owner.registry.createScope({ context: { actor: 'mcp-stdio', sessionId: context.sessionId } })
    return withOperationScope(scope, async () => {
      (await common.services.getInteraction(scope)).bind('grace')
      return run()
    })
  }
}
