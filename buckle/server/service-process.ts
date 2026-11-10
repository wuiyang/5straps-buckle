import type { Logger, LoggerRoot, RequestCli } from '@5straps/runtime'
import { askAtTerminal } from '../cli/ask.js'
import { setupCli } from '../cli/setup.js'
import type { TerminalOptions } from '../cli/terminal-consumer.js'
import { closeActionLogWriter } from '../common/adapters/action-log/action-log-writer.js'
import type { NodeConfig } from '../common/runtime/config.js'
import { recordEnvironmentFile } from '../common/runtime/environment-files.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import type { ConsoleWriter } from '../common/runtime/console.js'
import { LOG_CLOSE_DEADLINE_MS } from '../common/runtime/log-budget.js'
import { BUCKLE_VERSION } from '../common/runtime/version.js'
import { AlreadyServingError, holdServe, refusedServeExit, watchStopRequest, type ServiceManagerKind } from '../common/services/node-service/serve-record.js'
import { mcpTarget, serveMcpStdio } from '../mcp/stdio.js'
import { serveHttp, type ServeHttpInput } from './serve.js'
import { builtEntryPath, setupServer } from './setup-server.js'
import { stopSignals } from './service-signals.js'

type ServiceKind = 'serve' | 'mcp'

interface Shutdown {
  close(): Promise<void>
  requested(): boolean
}

// One common runtime for the process; main owns its signals and closes it stage by stage.
export async function runService(input: { kind: ServiceKind; options: string[]; service: ServiceManagerKind | null; config: NodeConfig; logging: LoggerRoot; console?: ConsoleWriter }): Promise<void> {
  const { logging } = input
  trapUnhandledRejections(logging.logger)
  // At a terminal, `buckle serve` may ask for the node folder's name while it moves a 0.1 node onto workspaces (D85, Q15), as
  // every other command does, before the approval terminal starts; `buckle mcp` cannot, as stdin carries the protocol.
  const terminal = input.service === null ? terminalFor(input.kind, input.console) : null
  const common = initializeCommon({ config: input.config, role: input.kind === 'serve' ? 'server' : 'mcp', logger: logging.logger, ...(terminal ? { askName: question => askAtTerminal(question) } : {}) })
  // Before the process exits, which would stop the action log writer's worker in the middle of a write.
  common.owner.onClose('sinks', 'action log writes', async () => { await closeActionLogWriter({ deadlineMs: LOG_CLOSE_DEADLINE_MS }) })
  // Bounded: a sink that fails waits out its retries, which must not run past the close step's own limit.
  common.owner.onClose('sinks', 'logger', () => logging.flush({ deadlineMs: LOG_CLOSE_DEADLINE_MS }))
  // Main owns the process's one requester (nitro/coordination.md); its questions settle with the other waiters.
  const cli = setupCli({ terminal, logPending: true })
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  const shutdown = closeOnSignals({ common, logging })
  try {
    await startService({ ...input, common, logger: logging.logger, shutdown, requestCli: cli.requestCli })
  } catch (error) {
    // A stop requested during startup is a normal stop, not a failed start.
    if (shutdown.requested()) return
    logging.logger.fatal('Buckle failed to start', { error })
    // A definition does not restart a node that found another serving its state directory: the unit does not on
    // SERVE_REFUSED_EXIT, and launchd does not on 0 (refusedServeExit).
    process.exitCode = error instanceof AlreadyServingError ? refusedServeExit(input.service) : 1
    await shutdown.close()
  }
}

async function startService(input: { kind: ServiceKind; options: string[]; service: ServiceManagerKind | null; config: NodeConfig; common: BuckleCommon; logger: Logger; shutdown: Shutdown; requestCli: RequestCli; console?: ConsoleWriter }): Promise<void> {
  if (input.kind === 'serve') {
    // Before anything else, so a second node on this state directory is refused before it builds anything.
    const held = await holdService(input)
    // Every Buckle process on this state directory keeps the file this node reads from tools, a buckle mcp whose environment names none too.
    await recordEnvironmentFile({ stateDirectory: input.config.stateDirectory, file: input.config.environmentFile })
    // The built app, with the host and the one cli:call listener bound before anything is accepted.
    const server = await setupServer({ ...input, entryPath: builtEntryPath() })
    // HTTP asks through the app's cli:call hook, which main's listener answers (ruling 4 of 2026-09-28).
    input.common.bindRequester(server.requestCli)
    return serveHttp({ ...input, server, ...held })
  }
  // MCP stdio is handed the requester itself; stdin carries the protocol.
  input.common.bindRequester(input.requestCli)
  // The client closing stdin ends the session. 'end' needs a reader, so attaching first misses nothing.
  process.stdin.once('end', () => { void input.shutdown.close() })
  return serveMcpStdio({ ...input, target: mcpTarget(input.options) })
}

/**
 * Every serve holds the state directory's serve lock for its life and records its pid, version, and address once it
 * listens, a terminal's too, under the manager `terminal`, so `buckle serve --background` and the service family see it
 * (fix brief 6, item 1). A serve at a terminal stops there, with Ctrl-C, and lists its workspaces there. A serve with no
 * terminal (Phase 3) also stops when `buckle service stop` asks it to (Windows delivers a service no SIGTERM), and logs
 * the workspaces it serves, as no terminal shows them.
 */
async function holdService(input: { config: NodeConfig; common: BuckleCommon; logger: Logger; shutdown: Shutdown; service: ServiceManagerKind | null }): Promise<Pick<ServeHttpInput, 'onListening' | 'write'>> {
  const { stateDirectory } = input.config
  const hold = await holdServe({ stateDirectory, owner: input.common.owner })
  const onListening: NonNullable<ServeHttpInput['onListening']> = address => hold.publish({ manager: input.service ?? 'terminal', version: BUCKLE_VERSION, host: address.address, port: address.port })
  if (input.service === null) return { onListening }
  const onStop = () => {
    input.logger.info('Shutdown requested', { by: 'buckle service stop' })
    void input.shutdown.close()
  }
  input.common.owner.onClose('timers', 'stop request', watchStopRequest({ stateDirectory, onStop }))
  return { onListening, write: text => input.logger.info('Workspaces served', { workspaces: text.trimEnd() }) }
}

// A terminal running `buckle serve` can answer directly; under mcp, stdin carries the protocol. The question is
// shown on stderr, so both ends must be a terminal: with stderr redirected a key would answer an action never seen
// (review L2 of the continuation review). Its questions go through the writer its log lines do, where there is one (C3).
function terminalFor(kind: ServiceKind, writer: ConsoleWriter | undefined): TerminalOptions | null {
  return kind === 'serve' && process.stdin.isTTY && process.stderr.isTTY ? { input: process.stdin, output: process.stderr, ...(writer ? { console: writer } : {}) } : null
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
  await input.logging.close({ deadlineMs: LOG_CLOSE_DEADLINE_MS })
  // Every subsystem Buckle starts has a close step; a handle a plugin or a child left open must not keep the process alive.
  process.exit()
}

function trapUnhandledRejections(target: Logger): void {
  process.on('unhandledRejection', (error) => {
    target.fatal('Unhandled rejection', { error })
    process.exitCode = 1
  })
}
