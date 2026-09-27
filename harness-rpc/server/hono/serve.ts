import { serve } from '@hono/node-server'
import { requireAuthToken, type BuckleConfig } from '../../common/runtime/config.js'
import { logger } from '../../common/runtime/logger.js'
import { createApprovalDelivery } from '../../common/services/approvals/approval-delivery.js'
import { createRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createHttpApp } from './http-app.js'

export async function serveHttp(config: BuckleConfig): Promise<void> {
  const authToken = requireAuthToken(config)
  // A terminal running `buckle serve` can answer directly; stdin here is not the protocol.
  const runtime = await createRuntime({
    config,
    channel: approvals => createApprovalDelivery({ config, approvals, workspaceId: 'default', prompt: Boolean(process.stdin.isTTY) }),
  })
  const manifest = runtime.manifest()

  const app = createHttpApp({ config, runtime, authToken })

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
    logger.info('5straps Buckle listening', {
      host: info.address,
      port: info.port,
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
  })
}
