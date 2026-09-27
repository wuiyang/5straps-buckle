#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLogger, createStderrJsonSink, type Logger, type LoggerRoot } from '@5straps/runtime'
import { runCli, runInitCommand, runSettingsCommand } from './cli/main.js'
import { loadConfig, type BuckleConfig } from './common/runtime/config.js'
import { loadEnvironmentFile } from './common/runtime/environment.js'
import { initializeCommon, type BuckleCommon } from './common/runtime/initialize.js'
import { logger } from './common/runtime/logger.js'
import { createApprovalDelivery } from './common/services/approvals/approval-delivery.js'
import { serveMcpStdio } from './mcp/stdio.js'
import { serveHttp } from './server/hono/serve.js'

export type Mode =
  | { kind: 'init' | 'settings' | 'cli'; argv: string[] }
  | { kind: 'serve' | 'mcp' }

type ServiceKind = 'serve' | 'mcp'

interface Shutdown {
  close(): Promise<void>
  requested(): boolean
}

export function selectMode(argv: readonly string[]): Mode {
  const [command, ...rest] = argv
  if (command === 'init' || command === 'settings') return { kind: command, argv: rest }
  if (command === 'serve' || command === 'mcp') return { kind: command }
  return { kind: 'cli', argv: [...argv] }
}

/** The exit code of a one-shot command; undefined once serve or mcp is running. */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  const mode = selectMode(argv)
  // Before the file is loaded, so `settings show` can tell the file's values from the shell's.
  if (mode.kind === 'init') return (await runInitCommand(mode.argv)).exitCode
  if (mode.kind === 'settings') return (await runSettingsCommand(mode.argv)).exitCode

  loadEnvironmentFile()
  const config = loadConfig()
  if (mode.kind === 'cli') return (await runCli({ argv: mode.argv, config })).exitCode
  await runService({ kind: mode.kind, config })
  return undefined
}

// One common runtime for the process; main owns its signals and closes it stage by stage.
async function runService(input: { kind: ServiceKind; config: BuckleConfig }): Promise<void> {
  const logging = createLogger({ component: 'buckle', sinks: [createStderrJsonSink()] })
  trapUnhandledRejections(logging.logger)
  const common = initializeCommon({ config: input.config, role: input.kind === 'serve' ? 'server' : 'mcp', logger: logging.logger, adapters: {
    approvalChannel: approvals => createApprovalDelivery({ config: input.config, approvals, workspaceId: 'default', prompt: promptsInTerminal(input.kind) }),
  } })
  common.owner.onClose('sinks', 'logger', () => logging.flush())
  const shutdown = closeOnSignals({ common, logging })
  try {
    await startService({ ...input, common, logger: logging.logger, shutdown })
  } catch (error) {
    // A stop requested during startup is a normal stop, not a failed start.
    if (shutdown.requested()) return
    logging.logger.fatal('Buckle failed to start', { error })
    process.exitCode = 1
    await shutdown.close()
  }
}

function startService(input: { kind: ServiceKind; config: BuckleConfig; common: BuckleCommon; logger: Logger; shutdown: Shutdown }): Promise<void> {
  if (input.kind === 'serve') return serveHttp(input)
  // The client closing stdin ends the session. 'end' needs a reader, so attaching first misses nothing.
  process.stdin.once('end', () => { void input.shutdown.close() })
  return serveMcpStdio(input)
}

// A terminal running `buckle serve` can answer directly; under mcp, stdin carries the protocol.
function promptsInTerminal(kind: ServiceKind): boolean {
  return kind === 'serve' && Boolean(process.stdin.isTTY)
}

function closeOnSignals(input: { common: BuckleCommon; logging: LoggerRoot }): Shutdown {
  let closing: Promise<void> | undefined
  const close = () => (closing ??= closeProcess(input))
  const onSignal = (signal: NodeJS.Signals) => {
    input.logging.logger.info('Shutdown requested', { signal })
    void close()
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  return { close, requested: () => closing !== undefined }
}

async function closeProcess(input: { common: BuckleCommon; logging: LoggerRoot }): Promise<void> {
  await input.common.owner.close().catch((error: unknown) => {
    input.logging.logger.error('Buckle closed with errors', { error })
    process.exitCode = 1
  })
  input.logging.logger.info('5straps Buckle stopped')
  await input.logging.close()
  // Subsystems without a close step yet (language servers, terminals, browser sessions) may still hold handles.
  process.exit()
}

function trapUnhandledRejections(target: Logger): void {
  process.on('unhandledRejection', (error) => {
    target.fatal('Unhandled rejection', { error })
    process.exitCode = 1
  })
}

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

// Node realpaths the main module, so an npm bin symlink still matches; the mode-dispatch test imports this file.
function isProcessEntry(): boolean {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url))
}

if (isProcessEntry()) {
  exitQuietlyOnClosedPipe()
  main(process.argv.slice(2)).then(
    exitCode => { if (exitCode !== undefined) process.exitCode = exitCode },
    error => {
      logger.error('Buckle failed to start', { message: error instanceof Error ? error.message : 'Unknown error' })
      process.exitCode = 1
    },
  )
}
