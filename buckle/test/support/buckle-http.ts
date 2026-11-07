import type { RequestCli } from '@5straps/runtime'
import { inject } from 'vitest'
import type { NitroApp } from 'nitro/types'
import { setupCli } from '../../cli/setup.js'
import type { TerminalOptions } from '../../cli/terminal-consumer.js'
import type { BuckleConfig } from '../../common/runtime/config.js'
import type { ActionLog } from '../../common/types/ports/action-log.js'
import { configFromEnvironment, nodeConfigOf } from './workspace-config.js'
import { initializeCommon, type BuckleCommon } from '../../common/runtime/initialize.js'
import { logger } from '../../common/runtime/log.js'
import type { BuckleServices } from '../../common/runtime/services.js'
import type { CoreRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { coreOf } from './workspaces.js'
import { createHttpServer, setupServer } from '../../server/setup-server.js'
import { layerRoutes, type ServedRoute } from './routes.js'
import { idOf } from './workspaces.js'

/** A node as serve composes it, answering in process through its Nitro app, or on node:http through the built middleware serve uses. */
export interface BuckleHttp {
  readonly config: BuckleConfig
  readonly common: BuckleCommon
  /** The node folder's workspace: the folder the environment names, as migration makes it of a node set up before the workspace model. */
  readonly runtime: CoreRuntime
  /** The node's own log, where refusals before a workspace is known and registry changes are recorded. */
  readonly nodeActions: ActionLog
  /** A path of the node folder's workspace's setup face: `/workspaces/<id>/setup/<path>`, since the node level serves no workspace (D85, Q15). */
  setup(path: string): string
  /** The id of the workspace named `name`, as the registry assigned it (D85, Q15). */
  idOf(name: string): Promise<string>
  readonly services: BuckleServices
  readonly nitroApp: NitroApp
  /** The process's one requester, which the common runtime and the app's host both carry. */
  readonly requestCli: RequestCli
  /** A path is taken relative to the node; a Request or full URL keeps its own origin, as fetch would send it. */
  request(input: string | Request, init?: RequestInit): Promise<Response>
  /** The same node behind serve's node:http listener (the built entry's middleware) on a free port, for wire-level tests; closes with the node. */
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
  const config = configFromEnvironment(input.environment)
  input.configure?.(config)
  const common = initializeCommon({ config: nodeConfigOf(config), role: 'server' })
  const cli = setupCli({ terminal: input.terminal ?? null })
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  const server = await setupServer({ common, logger, requestCli: cli.requestCli, entryPath })
  common.bindRequester(server.requestCli)
  let closing: Promise<void> | undefined
  const close = () => (closing ??= common.owner.close().finally(() => {
    server.release()
    if (holders.get(entryPath) === close) holders.delete(entryPath)
  }))
  holders.set(entryPath, close)
  await common.start()
  const workspaces = await common.services.getWorkspaces()
  const runtime = coreOf((await workspaces.resolve(config.workspaceId)).runtime)
  return {
    config, common, runtime, nodeActions: workspaces.nodeActions, services: common.services, nitroApp: server.nitroApp, requestCli: server.requestCli,
    setup: path => `/workspaces/${runtime.workspaceId}/setup/${path}`,
    idOf: async name => idOf(await common.services.getWorkspaces(), name),
    request: async (request, init) => server.nitroApp.fetch(request instanceof Request ? new Request(request, init) : new Request(new URL(request, 'http://127.0.0.1'), init)),
    // As serve listens (server/serve.ts): the built entry's middleware, with srvx's lazy body and socket-bound signal.
    listen: async () => {
      const http = createHttpServer({ common, listener: server.middleware })
      const address = await http.listen({ host: '127.0.0.1', port: 0 })
      return `http://127.0.0.1:${address.port}`
    },
    routes: () => layerRoutes(input.headless ? ['common', 'mcp'] : ['common', 'mcp', 'admin']),
    close,
  }
}

/** The agent token a /setup/workspaces registration answered with, shown once (D83 (3)); any other answer fails the test. */
export async function mintedToken(response: Promise<Response> | Response): Promise<string> {
  const answered = await response
  if (answered.status !== 201) throw new Error(`Registration answered ${answered.status}: ${await answered.text()}`)
  return (await answered.json() as { token: { token: string } }).token.token
}
