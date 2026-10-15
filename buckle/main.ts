#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger, LoggerRoot, RequestCli } from '@5straps/runtime'
import { answerWithoutConfiguration, runCli, runInitCommand, runSettingsCommand } from './cli/main.js'
import { setupCli } from './cli/setup.js'
import { clientCommand } from './cli/client.js'
import type { TerminalOptions } from './cli/terminal-consumer.js'
import { configureOwnerOnlyCheck, SKIP_OWNER_ONLY_FLAG } from './common/adapters/file-modes.js'
import { environmentWorkspaceKeys, loadConfig, type NodeConfig } from './common/runtime/config.js'
import { loadEnvironmentFile } from './common/runtime/environment.js'
import { initializeCommon, type BuckleCommon } from './common/runtime/initialize.js'
import { configureRootLogger, flushLogs, logger, loggerConfigFrom } from './common/runtime/log.js'
import { mcpTarget, serveMcpStdio } from './mcp/stdio.js'
import { serveHttp } from './server/serve.js'
import { builtEntryPath, setupServer } from './server/setup-server.js'

export type Mode =
  | { kind: 'init' | 'settings' | 'client' | 'cli'; argv: string[] }
  | { kind: 'serve' | 'mcp'; options: string[] }

type ServiceKind = 'serve' | 'mcp'

/** How long the logger may take to flush its last lines at exit. */
const LOGGING_CLOSE_MS = 2_000

interface Shutdown {
  close(): Promise<void>
  requested(): boolean
}

/**
 * Flags any command takes, before or after its command word, up to a `--`: each is taken out here, so no
 * command's own parser sees it (`buckle policy` refuses a flag it does not know).
 */
export function takeGlobalFlags(argv: readonly string[]): { argv: string[]; skipOwnerOnlyCheck: boolean } {
  const terminator = argv.indexOf('--')
  const end = terminator === -1 ? argv.length : terminator
  const flags = argv.slice(0, end)
  return {
    argv: [...flags.filter(argument => argument !== SKIP_OWNER_ONLY_FLAG), ...argv.slice(end)],
    skipOwnerOnlyCheck: flags.includes(SKIP_OWNER_ONLY_FLAG),
  }
}

export function selectMode(argv: readonly string[]): Mode {
  const [command, ...rest] = argv
  if (command === 'init' || command === 'settings' || command === 'client') return { kind: command, argv: rest }
  if (command === 'serve' || command === 'mcp') return { kind: command, options: rest }
  return { kind: 'cli', argv: [...argv] }
}

/** The exit code of a one-shot command; undefined once serve or mcp is running. */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  const global = takeGlobalFlags(argv)
  configureOwnerOnlyCheck({ skip: global.skipOwnerOnlyCheck })
  const mode = selectMode(global.argv)
  if (!('argv' in mode)) {
    await runService({ kind: mode.kind, options: mode.options, ...configureProcess() })
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
  // A person's device, which needs no node: its own key and the node it signs for.
  if (mode.kind === 'client') return (await clientCommand(mode.argv)).exitCode
  // Nothing the environment holds may refuse these: `buckle --version` is the first check anyone runs.
  const answered = answerWithoutConfiguration(mode.argv)
  if (answered) return answered.exitCode
  return (await runCli({ argv: mode.argv, config: configureProcess().config })).exitCode
}

function configureProcess(): { config: NodeConfig; logging: LoggerRoot } {
  const environment = loadEnvironmentFile()
  const logging = configureRootLogger(loggerConfigFrom(process.env))
  // Warn only for now: whether a loose file refuses to start is the owner's call (review M4).
  if (environment.openToOthers && environment.file) logging.logger.warn(`The environment file ${environment.file} can be read by other users; run chmod 600 ${environment.file}`)
  // Read once, when a node moves to the workspace model; from then on an MCP config's env cannot widen a workspace (Q14).
  const ignored = environmentWorkspaceKeys(process.env)
  if (ignored.length > 0) logging.logger.warn(`Ignored: ${ignored.join(', ')} ${ignored.length === 1 ? 'is a workspace setting' : 'are workspace settings'}, read only when a node moves to the workspace model. Change a workspace with buckle workspace set or buckle policy, and remove these with buckle settings unset or from the shell or MCP config's env.`)
  return { config: loadConfig(), logging }
}

// A one-shot command answers a person at a terminal: the reason on one line, the detail at debug level.
function refuseCommand(error: unknown): number {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  logger.debug('Command refused', { error })
  return 1
}

// One common runtime for the process; main owns its signals and closes it stage by stage.
async function runService(input: { kind: ServiceKind; options: string[]; config: NodeConfig; logging: LoggerRoot }): Promise<void> {
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

async function startService(input: { kind: ServiceKind; options: string[]; config: NodeConfig; common: BuckleCommon; logger: Logger; shutdown: Shutdown; requestCli: RequestCli }): Promise<void> {
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
  return serveMcpStdio({ ...input, target: mcpTarget(input.options) })
}

// A terminal running `buckle serve` can answer directly; under mcp, stdin carries the protocol. The question is
// shown on stderr, so both ends must be a terminal: with stderr redirected a key would answer an action never seen
// (review L2 of the continuation review).
function terminalFor(kind: ServiceKind): TerminalOptions | null {
  return kind === 'serve' && process.stdin.isTTY && process.stderr.isTTY ? { input: process.stdin, output: process.stderr } : null
}

/**
 * The signals that ask the service to stop. Windows delivers no SIGTERM: Ctrl-C there is SIGINT, Ctrl-Break is
 * SIGBREAK, and closing the console window is SIGHUP, after which Windows ends the process within seconds.
 */
export function stopSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGTERM', 'SIGINT']
}

function closeOnSignals(input: { common: BuckleCommon; logging: LoggerRoot }): Shutdown {
  let closing: Promise<void> | undefined
  const close = () => (closing ??= closeProcess(input))
  const onSignal = (signal: NodeJS.Signals) => {
    input.logging.logger.info('Shutdown requested', { signal })
    void close()
  }
  for (const signal of stopSignals()) process.once(signal, onSignal)
  return { close, requested: () => closing !== undefined }
}

async function closeProcess(input: { common: BuckleCommon; logging: LoggerRoot }): Promise<void> {
  await input.common.owner.close().catch((error: unknown) => {
    input.logging.logger.error('Buckle closed with errors', { error })
    process.exitCode = 1
  })
  input.logging.logger.info('5straps Buckle stopped')
  // Bounded: a sink that waits for stderr to drain (an unread pipe) must not keep the process alive (review L3 of B20-B22).
  await Promise.race([input.logging.close(), new Promise(resolve => setTimeout(resolve, LOGGING_CLOSE_MS).unref())])
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
