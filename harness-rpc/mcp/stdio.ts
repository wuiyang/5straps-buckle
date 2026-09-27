import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { Logger } from '@5straps/runtime'
import type { BuckleConfig } from '../common/runtime/config.js'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import { createAuditedStdioTransport } from './audited-stdio-transport.js'
import { createMcpServer } from './server.js'
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
  const stdio = serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, version, trustedApprovalResponses: true }), { transport })
  common.owner.onClose('accept', 'mcp stdio', () => stdio.close())
  input.logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, tools: runtime.registry().capabilities().length })
}
