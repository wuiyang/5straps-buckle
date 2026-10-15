import type { AddressInfo } from 'node:net'
import type { Logger } from '@5straps/runtime'
import type { NodeConfig } from '../common/runtime/config.js'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import type { WorkspaceDescriptor } from '../common/services/workspaces/workspace-manager.js'
import { describeOnline, watchOnline } from './roster.js'
import { createHttpServer, type BuckleServer } from './setup-server.js'

/**
 * Serves the built app on node:http through the middleware its entry exports (srvx's node adapter),
 * the one request path. Listening before readiness is deliberate: the startup window answers 503,
 * never a refused connection. Every request carries a workspace's token, so the node needs no agent
 * credential of its own (D83).
 */
export async function serveHttp(input: { config: NodeConfig; common: BuckleCommon; logger: Logger; server: BuckleServer }): Promise<void> {
  const { config, common } = input
  const http = createHttpServer({ common, listener: input.server.middleware })
  const address = await http.listen({ host: config.host, port: config.port })
  await common.start()
  const workspaces = await common.services.getWorkspaces()
  logListening({ logger: input.logger, config, workspaces: workspaces.list(), address })
  // On the terminal the questions are asked on, the online workspaces, and again after each change (item 6).
  const write = (text: string) => void process.stderr.write(text)
  write(await describeOnline(workspaces))
  common.owner.onClose('jobs', 'workspace list', watchOnline({ workspaces, write }))
  if (config.experimentalAdminHttp) input.logger.warn('The admin HTTP face is on, as an experiment (BUCKLE_EXPERIMENTAL_ADMIN_HTTP): /setup answers the admin credential and signed requests of enrolled keys', { adminCredential: config.adminToken ? 'set' : 'unset' })
}

function logListening(input: { logger: Logger; config: NodeConfig; workspaces: WorkspaceDescriptor[]; address: AddressInfo }): void {
  const { config } = input
  input.logger.info('5straps Buckle listening', {
    host: input.address.address,
    port: input.address.port,
    serverId: config.serverId,
    workspacesOnline: input.workspaces.filter(workspace => workspace.online).map(workspace => workspace.id),
    approvalWebhook: config.approvalWebhook ? 'configured' : 'none',
    setupFace: config.experimentalAdminHttp && config.adminToken ? 'experimental' : 'none',
  })
}
