import { setTimeout as delay } from 'node:timers/promises'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createLogger, createStderrJsonSink, registerBackgroundWork, useScope, useScopeSafe, withOperationScope, type Logger, type LoggerRoot } from '@5straps/runtime'
import { setupCli } from './cli/setup.js'
import { loadConfig, type FixtureConfig } from './common/config.js'
import { initializeCommon, type FixtureRuntime } from './common/runtime.js'
import { createFixtureMcpServer } from './mcp/server.js'
import type { CliListenerMode } from './server/cli-listener.js'
import { setupServer } from './server/setup-server.js'

type Mode = 'serve' | 'mcp' | 'cli'
const HEARTBEAT_MS = 1_000
const LISTENER_MODES: readonly CliListenerMode[] = ['terminal', 'off', 'double', 'silent', 'reject']

// Entry points: `serve` (HTTP), `mcp` (stdio), `cli <command>`. stdout carries machine output or
// MCP frames only; every diagnostic goes to stderr.
async function main(argv: string[]): Promise<void> {
  const logging = createLogger({ component: 'fixture', sinks: [createStderrJsonSink()], level: 'debug' })
  trapProcessFailures(logging.logger)
  try {
    const mode = parseMode(argv[0])
    const config = loadConfig(process.env)
    if (mode === 'serve') await serve({ config, logging })
    else if (mode === 'mcp') await serveMcp({ config, logging })
    else await runCli({ config, logging, command: argv.slice(1) })
  } catch (error) {
    logging.logger.fatal('fixture failed', { error })
    process.exitCode = 1
    await logging.close()
  }
}

// setupCli, then setupServer (host + cli:call listener), then listen: nothing is accepted before
// the interaction handler exists (coordination.md, Ownership).
async function serve(input: { config: FixtureConfig; logging: LoggerRoot }): Promise<void> {
  const runtime = initializeCommon({ config: input.config, logger: input.logging.logger, role: 'server' })
  const cli = await setupCli({ runtime, terminalPath: process.env.FIXTURE_TERMINAL_SOCKET, secondTerminalPath: process.env.FIXTURE_SECOND_TERMINAL_SOCKET })
  const server = await setupServer({ runtime, requestCli: cli.requester.requestCli, entryPath: requiredEnv('FIXTURE_ENTRY'), listenerMode: listenerMode() })
  runtime.onClose('accept', 'http server', () => server.close())
  const heartbeat = setInterval(() => runtime.logger.debug('heartbeat'), HEARTBEAT_MS)
  runtime.onClose('timers', 'heartbeat', () => clearInterval(heartbeat))
  const shutdown = onceShutdown({ runtime, logging: input.logging })
  const port = await server.listen({ port: Number(process.env.FIXTURE_PORT ?? 0), host: '127.0.0.1' })
  runtime.logger.info('listening', { port })
  writeMachineLine({ event: 'listening', port })
  // Listening before readiness is deliberate: the startup window answers 503, never 500 (F05, F21).
  await runtime.start().catch(async (error: unknown) => {
    runtime.logger.fatal('startup failed', { error })
    process.exitCode = 1
    await shutdown()
  })
}

// MCP stdio: main injects requestCli directly; stdin/stdout belong to the protocol (F12, F18).
async function serveMcp(input: { config: FixtureConfig; logging: LoggerRoot }): Promise<void> {
  const runtime = initializeCommon({ config: input.config, logger: input.logging.logger, role: 'mcp' })
  const cli = await setupCli({ runtime, terminalPath: process.env.FIXTURE_TERMINAL_SOCKET })
  const shutdown = onceShutdown({ runtime, logging: input.logging })
  await runtime.start()
  const openScope = () => runtime.owner.registry.createScope({ context: { actor: 'mcp-stdio' } })
  const stdio = serveStdio(() => createFixtureMcpServer({ services: runtime.services, requestCli: cli.requester.requestCli, version: '0.0.0', openScope }))
  runtime.onClose('accept', 'mcp stdio', () => stdio.close())
  process.stdin.once('end', () => { void shutdown() })
  runtime.logger.info('mcp stdio ready')
}

async function runCli(input: { config: FixtureConfig; logging: LoggerRoot; command: string[] }): Promise<void> {
  const runtime = initializeCommon({ config: input.config, logger: input.logging.logger, role: 'cli' })
  await runtime.start()
  try {
    writeMachineLine(await runCliCommand({ runtime, command: input.command }))
  } finally {
    await runtime.owner.close()
    await input.logging.close()
  }
}

// Each command runs in its own operation scope, as CLI commands must enter one explicitly.
async function runCliCommand(input: { runtime: FixtureRuntime; command: string[] }): Promise<unknown> {
  const [group, action, text] = input.command
  if (group === 'scope-check') return checkScopes(input.runtime)
  const scope = input.runtime.owner.registry.createScope({ context: { actor: 'owner-cli' } })
  return withOperationScope(scope, async () => {
    const { services } = input.runtime
    if (group === 'notes' && action === 'add' && text) return { note: await (await services.getNotes()).add({ text, actor: useScope().context.actor ?? 'owner-cli' }) }
    if (group === 'notes' && action === 'list') return { notes: await (await services.getNotes()).list() }
    if (group === 'approvals' && action === 'list') return { approvals: await (await services.getApprovals()).list() }
    throw new TypeError(`Unknown command: ${input.command.join(' ')}`)
  })
}

// F20: outside a scope useScope throws; inside, background work is drained before the scope closes.
async function checkScopes(runtime: FixtureRuntime): Promise<unknown> {
  const outside = await new Promise<string>(resolve => setImmediate(() => {
    try { useScope(); resolve('no error') } catch (error) { resolve((error as { code?: string }).code ?? 'unknown') }
  }))
  let drained = false
  const scope = runtime.owner.registry.createScope({ context: { actor: 'owner-cli' } })
  await withOperationScope(scope, () => registerBackgroundWork(delay(50).then(() => { drained = true })))
  return { outsideError: outside, outsideSafe: await new Promise(resolve => setImmediate(() => resolve(useScopeSafe() ?? null))), drainedBeforeClose: drained, scopeState: scope.state }
}

function onceShutdown(input: { runtime: FixtureRuntime; logging: LoggerRoot }): () => Promise<void> {
  let closing: Promise<void> | undefined
  const shutdown = () => {
    closing ??= (async () => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      await input.runtime.owner.close().catch((error: unknown) => {
        input.runtime.logger.error('close failed', { error })
        process.exitCode = 1
      })
      // Leak evidence: after close only stdio handles may remain (no timers, sockets or databases).
      input.runtime.logger.info('active resources after close', { resources: process.getActiveResourcesInfo() })
      input.runtime.logger.info('close step', { stage: 'sinks', name: 'logger' })
      await input.logging.close()
    })()
    return closing
  }
  const onSignal = (signal: NodeJS.Signals) => {
    input.runtime.logger.info('shutdown requested', { signal })
    void shutdown()
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  return shutdown
}

function trapProcessFailures(logger: Logger): void {
  process.on('unhandledRejection', (error) => {
    logger.fatal('unhandled rejection', { error })
    process.exitCode = 1
  })
}

function parseMode(value: string | undefined): Mode {
  if (value === 'serve' || value === 'mcp' || value === 'cli') return value
  throw new TypeError(`Usage: main.ts serve | mcp | cli <command>; got ${value ?? 'nothing'}`)
}

function listenerMode(): CliListenerMode {
  const mode = (process.env.FIXTURE_CLI_LISTENER ?? 'terminal') as CliListenerMode
  if (!LISTENER_MODES.includes(mode)) throw new TypeError(`FIXTURE_CLI_LISTENER must be one of ${LISTENER_MODES.join(', ')}`)
  return mode
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function writeMachineLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

await main(process.argv.slice(2))
