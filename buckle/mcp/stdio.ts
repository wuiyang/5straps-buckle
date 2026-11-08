import { parseArgs } from 'node:util'
import { resolve } from 'pathe'
import { SdkErrorCode } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { withOperationScope, type Logger } from '@5straps/runtime'
import type { BuckleConfig, NodeConfig } from '../common/runtime/config.js'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import { createAuditedStdioTransport } from './audited-stdio-transport.js'
import { WorkspaceError, WorkspaceRegistryError, type ManagedWorkspace, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ActionLog } from '../common/types/ports/action-log.js'
import { workspaceWait } from './holds.js'
import { createMcpServer, openForms, type ToolCallScope } from './server.js'
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
 * line, which would send every plain `buckle mcp` to the node folder's workspace (finding 1 of the Phase 1 review).
 */
export async function serveMcpStdio(input: { config: NodeConfig; common: BuckleCommon; logger: Logger; target: McpTarget }): Promise<void> {
  const { common } = input
  await common.start()
  const workspaces = await common.services.getWorkspaces()
  const legacy = input.target.workspace === undefined && input.target.dir === undefined && input.config.callerWorkspaceRoot !== undefined ? { dir: input.config.callerWorkspaceRoot } : {}
  const { config, runtime } = await workspaces.resolve(workspaces.target({ ...input.target, ...legacy, cwd: process.cwd() }))
  const transport = createAuditedStdioTransport({
    transport: createStdioWire({ stdin: process.stdin, stdout: process.stdout, maxBufferBytes: config.maxRequestBytes }),
    actions: { ...runtime.actions, record: entry => loggedIn(workspaces, runtime).record(entry) }, workspaceId: runtime.workspaceId, isKnownTool: name => runtime.registry().has(name),
  })
  const callScope = stdioCallScope(common)
  const stdio = serveStdio(() => createStdioServer({ runtime, config, callScope, beforeCall: stillServed(workspaces, runtime) }), { transport })
  common.owner.onClose('accept', 'mcp stdio', () => stdio.close())
  input.logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), tools: runtime.registry().capabilities().length })
}

/**
 * The MCP server a stdio session is served by. The owner's own host answers an ask, so its answers count as a person's
 * while the workspace's forms setting is on; a call that asks waits the workspace's own wait, which a caller's hint may
 * shorten, where the HTTP face holds at most MCP_HOLD_MS (the MCP asks brief, item 1).
 */
export function createStdioServer(input: { runtime: BuckleRuntime; config: Pick<BuckleConfig, 'serverName' | 'serverId' | 'approvalTimeoutMs'>; callScope: ToolCallScope; beforeCall: () => Promise<void> }) {
  const { runtime, config } = input
  return createMcpServer({ runtime, serverName: config.serverName, serverId: config.serverId, version: runtime.manifest().version, forms: openForms(runtime, config.serverId), callScope: input.callScope, isCancel: isExplicitCancel, beforeCall: input.beforeCall, approvalWait: () => workspaceWait(config.approvalTimeoutMs) })
}

/**
 * Where a refused or served call is audited: the workspace's own log while the registry holds it, else the node's. A
 * workspace removed since this process started, and purged, has no folder, which writing its log would make again (fix
 * brief 4, finding 32); a registry that will not read leaves the workspace's log as it was.
 */
function loggedIn(workspaces: WorkspaceManager, runtime: BuckleRuntime): ActionLog {
  try { return workspaces.known(runtime.workspaceId) ? runtime.actions : workspaces.nodeActions } catch { return runtime.actions }
}

/**
 * Asks the registry before each call whether this process's runtime is still the one its workspace is served by, as
 * `buckle serve` does at each request (resolve compares the record): a workspace removed or taken offline since this
 * process started, or removed and registered again, answers every call with a refusal naming it, no path among it.
 * A workspace enabled again is served again by the same runtime, which this process kept open.
 */
function stillServed(workspaces: WorkspaceManager, runtime: BuckleRuntime): () => Promise<void> {
  return async () => {
    const name = runtime.workspaceName()
    let current: ManagedWorkspace
    try { current = await workspaces.resolve(runtime.workspaceId) } catch (error) {
      // The registry's own message names its file, which the state directory hides from agents; the owner's log has it.
      if (error instanceof WorkspaceRegistryError) throw new WorkspaceError(`Workspace ${name} is not served now: the node's registry cannot be read; the owner's log says why. Tell the person you work with.`, 409)
      if (error instanceof WorkspaceError) {
        const why = error.status === 404 ? 'it was removed' : error.message.replace(/^Workspace is /, 'it is ')
        throw new WorkspaceError(`Workspace ${name} is not served now: ${why}. Tell the person you work with: once it is served again this server answers, and if it was removed and added again this MCP server must be restarted.`, 409)
      }
      throw error
    }
    if (current.runtime !== runtime) throw new WorkspaceError(`Workspace ${name} was removed and registered again, so this MCP server no longer serves it. Tell the person you work with to restart this MCP server.`, 409)
  }
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
