import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHttpServerClose, type Logger, type RequestCli } from '@5straps/runtime'
import { bindHost, createRequestCli, registerCliListener } from '@5straps/runtime/nitro'
import type { NitroApp } from 'nitro/types'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import { PACKAGE_ROOT } from '../common/runtime/package-root.js'
import { approvalPending } from '../common/services/approvals/interaction.js'
import type { BuckleHttpServices } from '../common/types/ports/mcp-http.js'
import { createMcpHttpHandlers } from '../mcp/http.js'
import type { BuiltEntry } from './built-entry.js'

/** The built Nitro app, bound to this process's common runtime and requester. */
export interface BuckleServer {
  readonly nitroApp: NitroApp
  readonly middleware: RequestListener
  /** HTTP's requester: questions go through the app's cli:call hook to the one listener main registered. */
  readonly requestCli: RequestCli
  /** Unbinds the host and removes the listener, so another runtime can bind this app (tests). */
  release(): void
}

export interface HttpServer {
  listen(options: { host: string; port: number }): Promise<AddressInfo>
}

/** Where the build puts the Nitro app: .output beside dist, found from the package root. */
export function builtEntryPath(): string {
  return join(PACKAGE_ROOT, '.output', 'server', 'index.mjs')
}

/**
 * Imports the built app and binds it before anything is accepted (nitro/coordination.md, Ownership):
 * the host (owner, services, logger and the app's one requester) the context plugin reads per
 * request, then the one cli:call listener, which forwards each question to main's requester and
 * answers through respond. The host carries the requester, so event.context.requestCli is this one,
 * with the pending-approval fallback, never a second one without it (review L7 of B13-B14).
 */
export async function setupServer(input: { common: BuckleCommon; logger: Logger; requestCli: RequestCli; entryPath: string }): Promise<BuckleServer> {
  const { common } = input
  const entry = await import(pathToFileURL(input.entryPath).href) as BuiltEntry
  const requestCli = createRequestCli(entry.nitroApp, { onUnavailable: approvalPending, logger: input.logger })
  // The MCP face's handlers are the server's: kept per workspace runtime, closed with the connections.
  const mcpHandlers = createMcpHttpHandlers()
  common.owner.onClose('streams', 'mcp http handlers', () => mcpHandlers.close())
  const services: BuckleHttpServices = { ...common.services, getMcpHandlers: () => mcpHandlers }
  const unbind = bindHost(entry.nitroApp, { owner: common.owner, services, logger: input.logger, requestCli })
  const removeListener = registerCliListener(entry.nitroApp, async (request, respond, options) => {
    respond(await input.requestCli(request, { signal: options?.signal }))
  })
  input.logger.info('cli:call listener registered')
  return {
    nitroApp: entry.nitroApp,
    middleware: entry.middleware,
    requestCli,
    release: () => {
      removeListener()
      unbind()
    },
  }
}

/**
 * The node server. Close steps go on the common runtime's owner: it stops accepting at 'accept' and
 * its connections drain at 'streams'. No 'upgrade' listener: Buckle serves no WebSocket, and without
 * one Node answers an upgrade request as a plain request, so no socket is ever switched.
 */
export function createHttpServer(input: { common: BuckleCommon; listener: RequestListener }): HttpServer {
  const server = createServer(input.listener)
  registerHttpServerClose({ server, owner: input.common.owner })
  return { listen: options => listen(server, options) }
}

function listen(server: Server, options: { host: string; port: number }): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve(server.address() as AddressInfo)
    })
  })
}
