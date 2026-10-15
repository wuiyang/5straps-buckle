import { parseArgs } from 'node:util'
import { resolve } from 'pathe'
import { SdkErrorCode } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { withOperationScope, type Logger } from '@5straps/runtime'
import type { NodeConfig } from '../common/runtime/config.js'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import { createAuditedStdioTransport } from './audited-stdio-transport.js'
import { createMcpServer, type ToolCallScope } from './server.js'
import { createStdioWire } from './stdio-wire.js'

/** The workspace `buckle mcp` was asked for: `--workspace <name>` (its name, or its id), or `--dir <path>`, relative to where it starts. */
export interface McpTarget { workspace?: string; dir?: string }

export function mcpTarget(options: readonly string[]): McpTarget {
  const { values } = parseArgs({ args: [...options], options: { workspace: { type: 'string' }, dir: { type: 'string' } }, allowPositionals: false })
  return { ...(values.workspace === undefined ? {} : { workspace: values.workspace }), ...(values.dir === undefined ? {} : { dir: resolve(values.dir) }) }
}

/**
 * stdout carries the MCP protocol here, so every log line must go to stderr. The workspace served is the one asked
 * for, else the one whose folder holds BUCKLE_WORKSPACE_ROOT where this process's own environment sets it, as an MCP
 * config written before the workspace model does, else the one whose folder holds the directory the client started
 * this in (the workspace-model brief, item 3). buckle.env's line never steers it: a node moved from 0.1 keeps that
 * line, which would send every plain `buckle mcp` to workspace default (finding 1 of the Phase 1 review).
 */
export async function serveMcpStdio(input: { config: NodeConfig; common: BuckleCommon; logger: Logger; target: McpTarget }): Promise<void> {
  const { common } = input
  await common.start()
  const workspaces = await common.services.getWorkspaces()
  const legacy = input.target.workspace === undefined && input.target.dir === undefined && input.config.callerWorkspaceRoot !== undefined ? { dir: input.config.callerWorkspaceRoot } : {}
  const { config, runtime } = await workspaces.resolve(workspaces.target({ ...input.target, ...legacy, cwd: process.cwd() }))
  const version = runtime.manifest().version
  const transport = createAuditedStdioTransport({
    transport: createStdioWire({ stdin: process.stdin, stdout: process.stdout, maxBufferBytes: config.maxRequestBytes }),
    actions: runtime.actions, workspaceId: runtime.workspaceId, isKnownTool: name => runtime.registry().has(name),
  })
  const callScope = stdioCallScope(common)
  const stdio = serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, serverId: config.serverId, version, trustedApprovalResponses: true, callScope, isCancel: isExplicitCancel }), { transport })
  common.owner.onClose('accept', 'mcp stdio', () => stdio.close())
  input.logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), tools: runtime.registry().capabilities().length })
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
