import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { registerHttpServerClose, type Logger } from '@5straps/runtime'
import { Hono } from 'hono'
import { requireAuthToken, type BuckleConfig } from '../../common/runtime/config.js'
import type { BuckleCommon } from '../../common/runtime/initialize.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createHttpApp } from './http-app.js'
import { operationScopes, notReadyResponse, type ScopeEnv } from './operation-scope.js'

export interface HttpAdapter {
  listen(options: { host: string; port: number }): Promise<AddressInfo>
  /** Serves the app once the common runtime is ready; until then every request answers 503. */
  mount(app: Hono): void
}

// Listening before readiness is deliberate: the startup window answers 503, never a refused connection.
export async function serveHttp(input: { config: BuckleConfig; common: BuckleCommon; logger: Logger }): Promise<void> {
  const { config, common } = input
  const authToken = requireAuthToken(config)
  const http = createHttpAdapter(common)
  const address = await http.listen({ host: config.host, port: config.port })
  await common.start()
  const runtime = await common.services.getWorkspaceRuntime()
  http.mount(createHttpApp({ config, runtime, authToken }))
  logListening({ logger: input.logger, config, runtime, address })
}

export function createHttpAdapter(common: BuckleCommon): HttpAdapter {
  let root: Hono<ScopeEnv> | undefined
  const server = createServer(getRequestListener((request, env) => root ? root.fetch(request, env as HttpBindings) : notReadyResponse()))
  registerHttpServerClose({ server, owner: common.owner })
  return {
    listen: options => listen(server, options),
    mount(app) {
      const scoped = new Hono<ScopeEnv>()
      scoped.use('*', operationScopes(common))
      scoped.route('/', app)
      root = scoped
    },
  }
}

function listen(server: ReturnType<typeof createServer>, options: { host: string; port: number }): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve(server.address() as AddressInfo)
    })
  })
}

function logListening(input: { logger: Logger; config: BuckleConfig; runtime: BuckleRuntime; address: AddressInfo }): void {
  const { config, runtime } = input
  const manifest = runtime.manifest()
  input.logger.info('5straps Buckle listening', {
    host: input.address.address,
    port: input.address.port,
    serverId: config.serverId,
    sandbox: manifest.sandbox.mode,
    tools: manifest.tools.length,
    skills: manifest.skills.length,
    approvalGraceMs: config.approvalTimeoutMs,
    approvalWebhook: config.approvalWebhook ? 'configured' : 'none',
    setupFace: config.adminToken ? 'configured' : 'none',
    deniedRunReports: runtime.reporter.configured ? 'configured' : 'none',
    mount: runtime.paths().mount ?? 'none',
  })
}
