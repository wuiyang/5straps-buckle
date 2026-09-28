#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger, LoggerRoot, RequestCli } from '@5straps/runtime'
import { answerWithoutConfiguration, runCli, runInitCommand, runSettingsCommand } from './cli/main.js'
import { setupCli } from './cli/setup.js'
import type { TerminalOptions } from './cli/terminal-consumer.js'
import { loadConfig, type BuckleConfig } from './common/runtime/config.js'
import { loadEnvironmentFile, meetOutsideRoot, namesItsNode, outsideRootNotice } from './common/runtime/environment.js'
import { initializeCommon, type BuckleCommon } from './common/runtime/initialize.js'
import { configureRootLogger, flushLogs, logger, loggerConfigFrom } from './common/runtime/log.js'
import { serveMcpStdio } from './mcp/stdio.js'
import { serveHttp } from './server/serve.js'
import { builtEntryPath, setupServer } from './server/setup-server.js'

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
  if (!('argv' in mode)) {
    await runService({ kind: mode.kind, ...configureProcess({ servesTools: mode.kind === 'mcp' }) })
    return undefined
  }
  try {
    return await runCommand(mode)
  } catch (error) {
    return refuseCommand(error)
  }
}

async function runCommand(mode: Extract<Mode, { argv: string[] }>): Promise<number> {
  // Before the file is loaded, so `settings show` can tell the file's values from the shell's.
  if (mode.kind === 'init') return (await runInitCommand(mode.argv)).exitCode
  if (mode.kind === 'settings') return (await runSettingsCommand(mode.argv)).exitCode
  // Nothing the environment holds may refuse these: `buckle --version` is the first check anyone runs.
  const answered = answerWithoutConfiguration(mode.argv)
  if (answered) return answered.exitCode
  return (await runCli({ argv: mode.argv, config: configureProcess({ servesTools: mode.argv[0] === 'call' }).config })).exitCode
}

/** `servesTools`: an MCP session or `buckle call`, which an agent's project starts and which run tools on the root. */
function configureProcess(input: { servesTools: boolean }): { config: BuckleConfig; logging: LoggerRoot } {
  // Read before the file fills the environment in: only the caller's own choice counts.
  const namedNode = namesItsNode()
  const environment = loadEnvironmentFile()
  const logging = configureRootLogger(loggerConfigFrom(process.env))
  // Warn only for now: whether a loose file refuses to start is the owner's call (review M4).
  if (environment.openToOthers && environment.file) logging.logger.warn(`The environment file ${environment.file} can be read by other users; run chmod 600 ${environment.file}`)
  const config = loadConfig()
  const notice = input.servesTools ? outsideRootNotice({ namedNode, root: config.cwd, cwd: process.cwd(), file: environment.file }) : null
  if (notice) meetOutsideRoot(notice)
  return { config, logging }
}

// A one-shot command answers a person at a terminal: the reason on one line, the detail at debug level.
function refuseCommand(error: unknown): number {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  logger.debug('Command refused', { error })
  return 1
}

// One common runtime for the process; main owns its signals and closes it stage by stage.
async function runService(input: { kind: ServiceKind; config: BuckleConfig; logging: LoggerRoot }): Promise<void> {
  const { logging } = input
  trapUnhandledRejections(logging.logger)
  const common = initializeCommon({ config: input.config, role: input.kind === 'serve' ? 'server' : 'mcp', logger: logging.logger })
  common.owner.onClose('sinks', 'logger', () => logging.flush())
  // Main owns the process's one requester (nitro/coordination.md); its questions settle with the other waiters.
  const cli = setupCli({ terminal: terminalFor(input.kind) })
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  const shutdown = closeOnSignals({ common, logging })
  try {
    await startService({ ...input, common, logger: logging.logger, shutdown, requestCli: cli.requestCli })
  } catch (error) {
    // A stop requested during startup is a normal stop, not a failed start.
    if (shutdown.requested()) return
    logging.logger.fatal('Buckle failed to start', { error })
    process.exitCode = 1
    await shutdown.close()
  }
}

async function startService(input: { kind: ServiceKind; config: BuckleConfig; common: BuckleCommon; logger: Logger; shutdown: Shutdown; requestCli: RequestCli }): Promise<void> {
  if (input.kind === 'serve') {
    // The built app, with the host and the one cli:call listener bound before anything is accepted.
    const server = await setupServer({ ...input, entryPath: builtEntryPath() })
    // HTTP asks through the app's cli:call hook, which main's listener answers (ruling 4 of 2026-09-28).
    input.common.bindRequester(server.requestCli)
    return serveHttp({ ...input, server })
  }
  // MCP stdio is handed the requester itself; stdin carries the protocol.
  input.common.bindRequester(input.requestCli)
  // The client closing stdin ends the session. 'end' needs a reader, so attaching first misses nothing.
  process.stdin.once('end', () => { void input.shutdown.close() })
  return serveMcpStdio(input)
}

// A terminal running `buckle serve` can answer directly; under mcp, stdin carries the protocol.
function terminalFor(kind: ServiceKind): TerminalOptions | null {
  return kind === 'serve' && process.stdin.isTTY ? { input: process.stdin, output: process.stderr } : null
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
  // Every subsystem Buckle starts has a close step; a handle a plugin or a child left open must not keep the process alive.
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

// import.meta.main is exact under node (symlinked or extensionless entries included); tsx leaves it
// undefined, so fall back to comparing real paths. The mode-dispatch test imports this file.
function isProcessEntry(): boolean {
  return import.meta.main ?? invokedPathIsThisFile()
}

function invokedPathIsThisFile(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isProcessEntry()) {
  exitQuietlyOnClosedPipe()
  void main(process.argv.slice(2)).then(
    exitCode => { if (exitCode !== undefined) process.exitCode = exitCode },
    (error: unknown) => {
      logger.fatal('Buckle failed to start', { error })
      process.exitCode = 1
    },
  ).finally(() => flushLogs())
}
