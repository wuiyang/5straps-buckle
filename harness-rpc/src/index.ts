#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createDeferredApprovalChannel } from './adapters/approval/deferred-approval-channel.js'
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
  const runtime = await createRuntime({ config, channel: createDeferredApprovalChannel() })
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
    })
  })
}

/** stdout carries the MCP protocol here, so every log line must go to stderr. */
async function serveMcpStdio(config: BuckleConfig): Promise<void> {
  const runtime = await createRuntime({ config, channel: createDeferredApprovalChannel() })
  const version = runtime.manifest().version
  serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, version }))
  logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, tools: runtime.registry().capabilities().length })
}

main().catch(error => {
  logger.error('Buckle failed to start', { message: error instanceof Error ? error.message : 'Unknown error' })
  process.exitCode = 1
})
