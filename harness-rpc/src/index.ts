#!/usr/bin/env node
import { workspaceEnvironmentFile } from './faces/cli/workspace-config.js'
import { auditOperation } from './services/audit-operation.js'
import { createFileActionLog } from './adapters/action-log/file-action-log.js'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { serve } from '@hono/node-server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createStdioWire } from './faces/mcp/stdio-wire.js'
import { createAuditedStdioTransport } from './faces/mcp/audited-stdio-transport.js'
import { createApprovalDelivery } from './services/approval-delivery.js'
import { actionsPath, loadConfig, requireAuthToken, type BuckleConfig } from './config.js'
import { createHttpApp } from './faces/http-app.js'
import { createMcpServer } from './faces/mcp/server.js'
import { runInit } from './faces/cli/init.js'
import { runCli } from './faces/cli/main.js'
import { settingsCommand } from './faces/cli/settings.js'
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
  if (command === 'init') {
    process.exitCode = (await auditOperation({ actions: createFileActionLog(actionsPath(loadConfig())), workspaceId: 'default', tool: 'cli_init', sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, operation: () => runInit(rest) })).exitCode
    return
  }

  // Before the file is loaded, so `settings show` can tell the file's values from the shell's.
  if (command === 'settings') {
    process.exitCode = (await settingsCommand({ argv: rest, environment: process.env, environmentFile: environmentFilePath(), cwd: process.cwd() })).exitCode
    return
  }

  loadEnvironmentFile()
  const config = loadConfig()

  if (command === 'serve') return serveHttp(config)
  if (command === 'mcp') return serveMcpStdio(config)

  const result = await runCli({ argv: command ? [command, ...rest] : [], config })
  process.exitCode = result.exitCode
}

/**
 * Only BUCKLE_* names are taken, and a variable already in the environment wins, so an operator
 * override still applies.
 */
function loadEnvironmentFile(): void {
  const path = environmentFilePath()
  if (!path || !existsSync(path)) return
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (name.startsWith('BUCKLE_') && process.env[name] === undefined) process.env[name] = value
  }
}

function environmentFilePath(): string | null {
  return workspaceEnvironmentFile({ cwd: process.cwd(), explicit: process.env.BUCKLE_ENV_FILE })
}

async function serveHttp(config: BuckleConfig): Promise<void> {
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

/** stdout carries the MCP protocol here, so every log line must go to stderr. */
async function serveMcpStdio(config: BuckleConfig): Promise<void> {
  // stdin carries the MCP protocol, so there is no terminal here to ask a person in.
  const runtime = await createRuntime({
    config,
    channel: approvals => createApprovalDelivery({ config, approvals, workspaceId: 'default', prompt: false }),
  })
  const version = runtime.manifest().version
  const transport = createAuditedStdioTransport({
    transport: createStdioWire({ stdin: process.stdin, stdout: process.stdout, maxBufferBytes: config.maxRequestBytes }),
    actions: runtime.actions, workspaceId: runtime.workspaceId, isKnownTool: name => runtime.registry().has(name),
  })
  serveStdio(() => createMcpServer({ runtime, serverName: config.serverName, version, trustedApprovalResponses: true }), { transport })
  logger.info('5straps Buckle MCP stdio ready', { serverId: config.serverId, tools: runtime.registry().capabilities().length })
}

main().catch(error => {
  logger.error('Buckle failed to start', { message: error instanceof Error ? error.message : 'Unknown error' })
  process.exitCode = 1
})
