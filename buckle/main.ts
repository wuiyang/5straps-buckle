#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger, LoggerRoot, RequestCli } from '@5straps/runtime'
import { askAtTerminal } from './cli/ask.js'
import { answerWithoutConfiguration, runCli, runInitCommand, runServiceCommand, runSettingsCommand } from './cli/main.js'
import { setupCli } from './cli/setup.js'
import { clientCommand } from './cli/client.js'
import { copyCommand } from './cli/copy.js'
import type { TerminalOptions } from './cli/terminal-consumer.js'
import { closeActionLogWriter } from './common/adapters/action-log/action-log-writer.js'
import { closeLogService } from './common/adapters/action-log/log-service.js'
import { configureOwnerOnlyCheck, SKIP_OWNER_ONLY_FLAG } from './common/adapters/file-modes.js'
import { IGNORE_WARNING_FLAG } from './common/domain/global-flags.js'
import { ignoreWarningRefused } from './cli/ignore-warning.js'
import { loadConfig, stateDirectoryOf, unreadWorkspaceDefaults, type NodeConfig } from './common/runtime/config.js'
import { loadEnvironmentFile, nodeLocation, refuseForeignEnvironmentFile } from './common/runtime/environment.js'
import { recordEnvironmentFile } from './common/runtime/environment-files.js'
import { initializeCommon, type BuckleCommon } from './common/runtime/initialize.js'
import { createConsoleWriter, type ConsoleWriter } from './common/runtime/console.js'
import { LOG_CLOSE_DEADLINE_MS } from './common/runtime/log-budget.js'
import { configureRootLogger, flushLogs, logFormatFrom, logger, loggerConfigFrom, stderrFormat, type LogOutput } from './common/runtime/log.js'
import { BUCKLE_VERSION } from './common/runtime/version.js'
import { AlreadyServingError, holdServe, refusedServeExit, runningNode, serviceLogPath, watchStopRequest, type ServiceManagerKind } from './common/services/node-service/serve-record.js'
import { besideService } from './common/services/node-service/attach.js'
import { mcpTarget, serveMcpStdio } from './mcp/stdio.js'
import { wordList } from './common/domain/word-list.js'
import { serveHttp, type ServeHttpInput } from './server/serve.js'
import { parseServeOptions, SERVE_USAGE, startInBackground, useServiceLocation, type ServeOptions } from './server/service-mode.js'
import { builtEntryPath, setupServer } from './server/setup-server.js'
import { builtMainPath } from './common/runtime/package-root.js'

export type Mode =
  | { kind: 'init' | 'settings' | 'client' | 'cp' | 'service' | 'cli'; argv: string[] }
  | { kind: 'serve' | 'mcp'; options: string[] }

type ServiceKind = 'serve' | 'mcp'

interface Shutdown {
  close(): Promise<void>
  requested(): boolean
}

/**
 * Flags any command takes, before or after its command word, up to a `--`: each is taken out here, so no
 * command's own parser sees it (`buckle policy` refuses a flag it does not know).
 */
export function takeGlobalFlags(argv: readonly string[]): { argv: string[] } & GlobalFlags {
  const terminator = argv.indexOf('--')
  const end = terminator === -1 ? argv.length : terminator
  const flags = argv.slice(0, end)
  return {
    argv: [...flags.filter(argument => argument !== SKIP_OWNER_ONLY_FLAG && argument !== IGNORE_WARNING_FLAG), ...argv.slice(end)],
    skipOwnerOnlyCheck: flags.includes(SKIP_OWNER_ONLY_FLAG),
    ignoreWarning: flags.includes(IGNORE_WARNING_FLAG),
  }
}

/** `ignoreWarning`: the owner's command runs where its record cannot be written. */
interface GlobalFlags { skipOwnerOnlyCheck: boolean; ignoreWarning: boolean }

export function selectMode(argv: readonly string[]): Mode {
  const [command, ...rest] = argv
  if (command === 'init' || command === 'settings' || command === 'client' || command === 'cp' || command === 'service') return { kind: command, argv: rest }
  if (command === 'serve' || command === 'mcp') return { kind: command, options: rest }
  return { kind: 'cli', argv: [...argv] }
}

/** The exit code of a one-shot command; undefined once serve or mcp is running. */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  const global = takeGlobalFlags(argv)
  configureOwnerOnlyCheck({ skip: global.skipOwnerOnlyCheck })
  const mode = selectMode(global.argv)
  if (global.ignoreWarning && (!('argv' in mode) || mode.kind === 'cp')) return refuseCommand(new Error(ignoreWarningRefused(mode.kind)))
  if (!('argv' in mode)) {
    if (mode.kind === 'serve') return serve(mode.options, global.skipOwnerOnlyCheck)
    // Help needs no configuration, and starts nothing (finding 24 of the workspace-model Phase 1 review).
    if (mode.options.some(option => option === '--help' || option === '-h')) return printServiceUsage(mode.kind)
    await runService({ kind: mode.kind, options: mode.options, service: null, ...configureProcess(mode.kind) })
    return undefined
  }
  try {
    return await runCommand(mode, global)
  } catch (error) {
    return refuseCommand(error)
  } finally {
    // What the command queued for its audit log is written before it exits, for up to the deadline.
    await closeLogService({ deadlineMs: LOG_CLOSE_DEADLINE_MS })
  }
}

/**
 * `buckle serve`: at this terminal, detached from it with --background, or, with --service, as a service definition
 * runs it (Phase 3 of the workspace-model slice).
 */
async function serve(options: string[], skipOwnerOnlyCheck: boolean): Promise<number | undefined> {
  let parsed: ServeOptions
  try { parsed = parseServeOptions(options) } catch (error) { return refuseCommand(error) }
  if (parsed.help) return printServiceUsage('serve')
  // Before buckle.env is read: the node it starts reads the file itself, and this process holds no credential.
  if (parsed.background) {
    // Where the node lives, as a definition names it, else as this shell's environment does (paths alone).
    const named = parsed.location.stateDirectory
    const location = named === undefined ? nodeLocation(process.env) : { stateDirectory: named, environmentFile: parsed.location.environmentFile ?? null }
    const started = await startInBackground({ options: parsed, location, mainScript: builtMainPath(), skipOwnerOnlyCheck })
    ;(started.exitCode === 0 ? process.stdout : process.stderr).write(`${started.message}\n`)
    return started.exitCode
  }
  if (parsed.service === null) {
    const refused = await besideRunningNode()
    if (refused !== null) return refused
  }
  const output = serviceOutput(parsed)
  await runService({ kind: 'serve', options, service: parsed.service, ...configureProcess('serve', output) })
  return undefined
}

/**
 * Q5 of the 2026-10-15 rulings: `buckle serve` where a node already serves the state directory with no terminal (the
 * service, or --background) says Buckle is already running in service mode, names the command that answers its
 * approvals here, and exits 1, attaching nothing and starting nothing; beside a serve at another terminal it says to stop
 * that one there with Ctrl-C (fix brief 6, item 1). Read before buckle.env, as paths alone.
 */
async function besideRunningNode(): Promise<number | null> {
  let stateDirectory: string
  try { stateDirectory = nodeLocation(process.env).stateDirectory } catch (error) { return refuseCommand(error) }
  const running = await runningNode(stateDirectory)
  if (running === null) return null
  process.stderr.write(`${besideService({ running, command: 'buckle serve', stateDirectory, cwd: process.cwd() })}\n`)
  return 1
}

/**
 * Where a serve logs: stderr at a terminal; with no terminal, the state directory's one rotating file alone, from the
 * first line, so a start that fails is logged there too (Phase 3, item 6).
 */
function serviceOutput(parsed: ServeOptions): LogOutput {
  if (parsed.service === null) return 'stderr'
  useServiceLocation(parsed.location)
  const output = { file: serviceLogPath(stateDirectoryOf(process.env)) }
  configureRootLogger({}, output)
  return output
}

async function runCommand(mode: Extract<Mode, { argv: string[] }>, global: GlobalFlags): Promise<number> {
  const { ignoreWarning } = global
  // Before the file is loaded, so `settings show` can tell the file's values from the shell's.
  if (mode.kind === 'init') return (await runInitCommand(mode.argv, { ignoreWarning })).exitCode
  if (mode.kind === 'settings') return (await runSettingsCommand(mode.argv, { ignoreWarning })).exitCode
  // A person's device, which needs no node: its own key and the node it signs for.
  if (mode.kind === 'client') return (await clientCommand(mode.argv, process.env, { ignoreWarning })).exitCode
  // A copy to or from a node's workspace needs no node here either, and reads no buckle.env: its token is the shell's or
  // a file's, never the local node's settings.
  if (mode.kind === 'cp') return (await copyCommand(mode.argv)).exitCode
  // Before the file is loaded, so no credential is in this process's environment when it runs systemctl, launchctl, or
  // schtasks.exe.
  if (mode.kind === 'service') return (await runServiceCommand(mode.argv, { skipOwnerOnlyCheck: global.skipOwnerOnlyCheck, ignoreWarning })).exitCode
  // Nothing the environment holds may refuse these: `buckle --version` is the first check anyone runs.
  const answered = answerWithoutConfiguration(mode.argv)
  if (answered) return answered.exitCode
  return (await runCli({ argv: mode.argv, config: configureProcess('cli').config, ignoreWarning })).exitCode
}

function configureProcess(kind: ServiceKind | 'cli', output: LogOutput = 'stderr'): { config: NodeConfig; logging: LoggerRoot; console?: ConsoleWriter } {
  // An MCP client starts buckle mcp, from a config an agent may write: it reads no settings file but the node's own.
  if (kind === 'mcp') refuseForeignEnvironmentFile()
  // What the process was started with, before the file fills in the rest: migration reads the file alone (MigrationInput).
  const caller = { ...process.env }
  const environment = loadEnvironmentFile()
  // The CLI display slice, C1: once the file is read, its BUCKLE_LOG_FORMAT names stderr's format too; the service file stays JSON.
  const format = output === 'stderr' ? stderrFormat(logFormatFrom(process.env)) : null
  // C3: a serve whose stderr a person reads shares one writer, which owns the date separator, between its log lines, its
  // workspace list, and its approval questions.
  const writer = kind === 'serve' && format === 'human' ? createConsoleWriter({ output: process.stderr, dates: true, flush: flushLogs }) : undefined
  const logging = configureRootLogger(loggerConfigFrom(process.env), format === null ? output : { format, ...(writer ? { console: writer } : {}) })
  // Warn only for now: whether a loose file refuses to start is the owner's call (review M4).
  if (environment.openToOthers && environment.file) logging.logger.warn(`The environment file ${environment.file} can be read by other users; run chmod 600 ${environment.file}`)
  const layers = { file: environment.file === null ? null : { path: environment.file, values: environment.values }, caller, defaultsFromFileAlone: true }
  // D85, Q3: every workspace's defaults come from the file alone, so a shell's or an MCP config's env never lifts them.
  const unread = unreadWorkspaceDefaults(layers)
  const were = `${wordList(unread)} ${unread.length === 1 ? 'is' : 'are'} set in this command's environment`
  if (unread.length > 0) logging.logger.warn(`Not read: ${were}${environment.file === null ? ', but this node has no buckle.env' : ` to another value than ${environment.file} holds`}. A node takes every workspace's defaults, and the decision AI's keys and addresses, from its environment file alone, so a shell's or an MCP config's env cannot change them; ${environment.file === null ? 'run buckle init to write the file, then set them' : 'change them'} with buckle settings set, or a decision AI key or address in buckle.env by hand.`)
  return { config: loadConfig(process.env, process.platform, layers), logging, ...(writer ? { console: writer } : {}) }
}

const SERVICE_USAGE: Record<ServiceKind, string> = {
  serve: SERVE_USAGE,
  mcp: `Usage: buckle mcp [--workspace <name> | --dir <path>]

Serves one workspace's MCP over stdio, for an MCP client to start: the workspace --workspace names, else the one
holding --dir, else the one holding BUCKLE_WORKSPACE_ROOT where this command's own environment sets it, else the one
holding the directory it starts in. Logs go to stderr, as stdout carries the protocol.
`,
}

function printServiceUsage(kind: ServiceKind): number {
  process.stdout.write(SERVICE_USAGE[kind])
  return 0
}

// A one-shot command answers a person at a terminal: the reason on one line, the detail at debug level.
function refuseCommand(error: unknown): number {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  logger.debug('Command refused', { error })
  return 1
}

// One common runtime for the process; main owns its signals and closes it stage by stage.
async function runService(input: { kind: ServiceKind; options: string[]; service: ServiceManagerKind | null; config: NodeConfig; logging: LoggerRoot; console?: ConsoleWriter }): Promise<void> {
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
