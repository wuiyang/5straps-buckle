#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createCliApprovalChannel } from './adapters/approval/cli-approval-channel.js'
import { createWaitingApprovalChannel } from './adapters/approval/waiting-approval-channel.js'
import { createWebhookNotifier } from './adapters/approval/webhook-notifier.js'
import { loadConfig, requireAuthToken, type BuckleConfig } from './config.js'
import { createHttpApp } from './faces/http-app.js'
import { createMcpServer } from './faces/mcp/server.js'
import { runCli } from './faces/cli/main.js'
import { logger } from './logger.js'
import { createRuntime } from './runtime.js'

/**
 * `buckle tools | head -3` closes stdout while we are still writing to it. Without this the
 * process dies on an unhandled EPIPE and prints a stack trace over the user's terminal.
 */
function exitQuietlyOnClosedPipe(): void {
  process.stdout.on('error', error => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0)
    throw error
  })
}

async function main(): Promise<void> {
  exitQuietlyOnClosedPipe()
  const [command, ...rest] = process.argv.slice(2)
  const config = loadConfig()

  if (command === 'serve') return serveHttp(config)
  if (command === 'mcp') return serveMcpStdio(config)

  const result = await runCli({ argv: command ? [command, ...rest] : [], config })
  process.exitCode = result.exitCode
}

async function serveHttp(config: BuckleConfig): Promise<void> {
  const authToken = requireAuthToken(config)
  // A terminal running `buckle serve` can answer directly; stdin here is not the protocol.
  const runtime = await createRuntime({
    config,
    channel: approvals => buildServerChannel({ config, approvals, prompt: process.stdin.isTTY }),
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
    })
  })
}

/**
 * Holds a gated call open for the grace period, so an approval can arrive from a prompt here, a
 * `buckle approve` elsewhere, a POST to /v1/approvals, or whatever a webhook reached.
 */
function buildServerChannel(input: {
  config: BuckleConfig
  approvals: Parameters<Parameters<typeof createRuntime>[0]['channel']>[0]
  prompt: boolean
}) {
  return createWaitingApprovalChannel({
    approvals: input.approvals,
    timeoutMs: input.config.approvalTimeoutMs,
    notify: input.config.approvalWebhook ? createWebhookNotifier(input.config.approvalWebhook) : undefined,
    prompt: input.prompt ? createCliApprovalChannel() : undefined,
  })
}

/** stdout carries the MCP protocol here, so every log line must go to stderr. */
async function serveMcpStdio(config: BuckleConfig): Promise<void> {
  // stdin carries the MCP protocol, so there is no terminal here to ask a person in.
  const runtime = await createRuntime({
    config,
    channel: approvals => buildServerChannel({ config, approvals, prompt: false }),
  })
  const version = runtime.manifest().version
  serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, version }))
  logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, tools: runtime.registry().capabilities().length })
}

main().catch(error => {
  logger.error('Buckle failed to start', { message: error instanceof Error ? error.message : 'Unknown error' })
  process.exitCode = 1
})
