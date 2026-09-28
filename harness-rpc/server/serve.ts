import type { AddressInfo } from 'node:net'
import type { Logger } from '@5straps/runtime'
import { requireAuthToken, type BuckleConfig } from '../common/runtime/config.js'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createHttpServer, type BuckleServer } from './setup-server.js'

/**
 * Serves the built app on node:http through the middleware its entry exports (srvx's node adapter),
 * the one request path. Listening before readiness is deliberate: the startup window answers 503,
 * never a refused connection.
 */
export async function serveHttp(input: { config: BuckleConfig; common: BuckleCommon; logger: Logger; server: BuckleServer }): Promise<void> {
  const { config, common } = input
  // Refuses to serve without an agent credential before anything listens.
  requireAuthToken(config)
  const http = createHttpServer({ common, listener: input.server.middleware })
  const address = await http.listen({ host: config.host, port: config.port })
  await common.start()
  const runtime = await common.services.getWorkspaceRuntime()
  logListening({ logger: input.logger, config, runtime, address })
  if (config.experimentalAdminHttp) input.logger.warn('The admin HTTP face is on, as an experiment (BUCKLE_EXPERIMENTAL_ADMIN_HTTP): /setup answers the admin credential and signed requests of enrolled keys', { adminCredential: config.adminToken ? 'set' : 'unset' })
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
    setupFace: config.experimentalAdminHttp && config.adminToken ? 'experimental' : 'none',
    deniedRunReports: runtime.reporter.configured ? 'configured' : 'none',
    mount: runtime.paths().mount ?? 'none',
  })
}
