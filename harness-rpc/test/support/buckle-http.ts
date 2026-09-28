import { getRequestListener } from '@hono/node-server'
import type { RequestCli } from '@5straps/runtime'
import { inject } from 'vitest'
import type { NitroApp } from 'nitro/types'
import { setupCli } from '../../cli/setup.js'
import type { TerminalOptions } from '../../cli/terminal-consumer.js'
import { loadConfig, type BuckleConfig } from '../../common/runtime/config.js'
import { initializeCommon, type BuckleCommon } from '../../common/runtime/initialize.js'
import { logger } from '../../common/runtime/log.js'
import type { BuckleServices } from '../../common/runtime/services.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createDispatcher } from '../../server/hono/dispatch.js'
import { createHttpServer, setupServer } from '../../server/setup-server.js'
import { layerRoutes, type ServedRoute } from './routes.js'

/** A node as serve composes it, answering in process through the same dispatcher. */
export interface BuckleHttp {
  readonly config: BuckleConfig
  readonly common: BuckleCommon
  readonly runtime: BuckleRuntime
  readonly services: BuckleServices
  readonly nitroApp: NitroApp
  /** The process's one requester, which the common runtime and the app's host both carry. */
  readonly requestCli: RequestCli
  /** A path is taken relative to the node; a Request or full URL keeps its own origin, as fetch would send it. */
  request(input: string | Request, init?: RequestInit): Promise<Response>
  /** The same node behind the production node:http listener on a free port, for wire-level tests; closes with the node. */
  listen(): Promise<string>
  /** Every route the node serves: the built layers' file routes. */
  routes(): ServedRoute[]
  close(): Promise<void>
}

export interface BuckleHttpInput {
  environment: Record<string, string>
  /** 2 uses a second copy of the build, so two nodes run side by side with an app each. */
  instance?: 1 | 2
  /** The build without the admin layer. */
  headless?: boolean
  terminal?: TerminalOptions | null
  /** Adjusts the loaded configuration before the node starts, for settings no environment variable carries. */
  configure?: (config: BuckleConfig) => void
}

// Per built entry: releases the node that holds its app. A module's app is shared by the worker, so
// a node left open by an earlier test must not keep it.
const holders = new Map<string, () => Promise<void>>()

/**
 * Loads the config, initializes the common runtime and main's requester, binds the built app (host
 * and the one cli:call listener), then starts: serve's order, minus the socket.
 */
export async function createBuckleHttp(input: BuckleHttpInput): Promise<BuckleHttp> {
  const build = inject('buckleBuild')
  if (!build) throw new Error('buckleBuild was not provided: the root tests must run through `pnpm test:integration` (vitest run --config vitest.integration.config.ts), not a bare vitest invocation')
  const entryPath = input.headless ? build.entries.headless : input.instance === 2 ? build.entries.second : build.entries.full
  await holders.get(entryPath)?.()
  const config = loadConfig(input.environment)
  input.configure?.(config)
  const common = initializeCommon({ config, role: 'server' })
  const cli = setupCli({ terminal: input.terminal ?? null })
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  const server = await setupServer({ common, logger, requestCli: cli.requestCli, entryPath })
  common.bindRequester(server.requestCli)
  const dispatcher = createDispatcher({ nitroApp: server.nitroApp })
  let closing: Promise<void> | undefined
  const close = () => (closing ??= common.owner.close().finally(() => {
    server.release()
    if (holders.get(entryPath) === close) holders.delete(entryPath)
  }))
  holders.set(entryPath, close)
  await common.start()
  const runtime = await common.services.getWorkspaceRuntime()
  return {
    config, common, runtime, services: common.services, nitroApp: server.nitroApp, requestCli: server.requestCli,
    request: async (request, init) => dispatcher.fetch(request instanceof Request ? new Request(request, init) : new Request(new URL(request, 'http://127.0.0.1'), init)),
    // As serve listens (server/hono/serve.ts): the node adapter's Request, its lazy body and socket-bound signal.
    listen: async () => {
      const http = createHttpServer({ common, listener: getRequestListener(request => dispatcher.fetch(request)) })
      const address = await http.listen({ host: '127.0.0.1', port: 0 })
      return `http://127.0.0.1:${address.port}`
    },
    routes: () => layerRoutes(input.headless ? ['common', 'mcp'] : ['common', 'mcp', 'admin']),
    close,
  }
}
