import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { BuckleConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/logger.js'
import { createApprovalDelivery } from '../common/services/approvals/approval-delivery.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createAuditedStdioTransport } from './audited-stdio-transport.js'
import { createMcpServer } from './server.js'
import { createStdioWire } from './stdio-wire.js'

/** stdout carries the MCP protocol here, so every log line must go to stderr. */
export async function serveMcpStdio(config: BuckleConfig): Promise<void> {
  // stdin carries the MCP protocol, so there is no terminal here to ask a person in.
  const runtime = await createRuntime({
    config,
    channel: approvals => createApprovalDelivery({ config, approvals, workspaceId: 'default', prompt: false }),
  })
  const version = runtime.manifest().version
  const transport = createAuditedStdioTransport({
    transport: createStdioWire({ stdin: process.stdin, stdout: process.stdout, maxBufferBytes: config.maxRequestBytes }),
    actions: runtime.actions, workspaceId: runtime.workspaceId, isKnownTool: name => runtime.registry().has(name),
  })
  serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, version, trustedApprovalResponses: true }), { transport })
  logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, tools: runtime.registry().capabilities().length })
}
