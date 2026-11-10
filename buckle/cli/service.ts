import { SERVICE_USAGE } from './usage.js'
export { SERVICE_USAGE } from './usage.js'
import type { CliResult } from './result.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join } from 'pathe'
import { parseArgs } from 'node:util'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { SKIP_OWNER_ONLY_FLAG } from '../common/domain/global-flags.js'
import { actionsPath, defaultEnvironmentFile } from '../common/runtime/config.js'
import { recordEnvironmentFile } from '../common/runtime/environment-files.js'
import { nodeLocation } from '../common/runtime/environment.js'
import { logFormatFrom } from '../common/runtime/log.js'
import { createStoredLineRenderer } from '../common/runtime/log-render.js'
import { addressOf, atTerminal } from '../common/services/node-service/attach.js'
import { requestStop, runningNode, waitForStop, type RunningNode, type ServeRecord } from '../common/services/node-service/serve-record.js'
import { serviceLogPath } from '../common/domain/node-service-paths.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { NODE_SCOPE } from '../common/types/ports/client-keys.js'
import type { ProcessRunner } from '../common/types/ports/process-runner.js'
import { ServiceManagerError, type InstalledService, type NodeLocation, type ServiceDefinition, type ServiceManager } from '../common/types/ports/service-manager.js'
import { asksForHelp } from './help-request.js'



/** How long a command waits for the node to listen after a start, and to end after a stop. */
const START_WAIT_MS = 30_000
const STOP_WAIT_MS = 30_000
const DEFAULT_LOG_LINES = 50
const FOLLOW_POLL_MS = 500

export interface ServiceCommandInput {
  argv: string[]
  /** The process environment, read before buckle.env is: it holds no setting's value from the file. */
  environment: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  cwd: string
  run: ProcessRunner
  /** The built dist/main.js a definition runs. */
  mainScript: string
  /** The service manager this machine's service lives under; null where Buckle drives none here. */
  manager: (location: NodeLocation) => ServiceManager | null
  out?: (text: string) => void
  err?: (text: string) => void
  /** Ends `logs -f`; a terminal ends it with Ctrl-C. */
  signal?: AbortSignal
  /** Whether the command line carried --skip-owner-only-check, which `install` writes into the definition. */
  skipOwnerOnlyCheck?: boolean
  /** Whether the command line carried --ignore-warning, which runs the command where its record cannot be written. */
  ignoreWarning?: boolean
  /** Whether `out` is a terminal, where `logs` renders the stored lines for a person (the CLI display slice, C6). */
  stdoutIsTerminal?: boolean
}

interface ServiceContext {
  location: NodeLocation
  manager: ServiceManager | null
  input: ServiceCommandInput
  out: (text: string) => void
  err: (text: string) => void
}

const AUDITED = new Set(['install', 'uninstall', 'start', 'stop', 'restart'])
/** The subcommands that need a service manager; stop, status, and logs also act on a node --background started. */
const DEFINITION_ACTIONS = new Set(['install', 'uninstall', 'start', 'restart'])
/**
 * The exit code where Buckle drives no service manager on this platform (one other than Linux, macOS, and Windows), so
 * a script can tell "not supported here" from a refusal.
 */
export const UNSUPPORTED_EXIT = 2

/**
 * `buckle service` (Phase 3 of the workspace-model slice): the systemd user unit on Linux, the launchd agent on macOS,
 * and the Task Scheduler task on Windows. Dispatched before buckle.env is read, so no credential is in this process's
 * environment when it starts systemctl, launchctl, or schtasks.exe, and each program gets an environment built from a
 * fixed list besides. A change is audited in the node's log, where the node has a state directory.
 */
export async function serviceCommand(input: ServiceCommandInput): Promise<CliResult> {
  /** For the command's audit entry. */
  const out = input.out ?? (text => void process.stdout.write(text))
  const err = input.err ?? (text => void process.stderr.write(text))
  const [action, ...rest] = input.argv
  if (action === undefined || action === 'help' || action === '--help' || action === '-h') {
    ;(action === undefined ? err : out)(SERVICE_USAGE)
    return { exitCode: action === undefined ? 1 : 0 }
  }
  if (asksForHelp(rest)) {
    out(SERVICE_USAGE)
    return { exitCode: 0 }
  }
  let location: NodeLocation
  try { location = nodeLocation(input.environment, input.platform) } catch (error) { return fail(err, error instanceof Error ? error.message : String(error)) }
  const context: ServiceContext = { location, manager: input.manager(location), input, out, err }
  const run = () => dispatch(context, action, rest)
  if (!AUDITED.has(action) || !existsSync(location.stateDirectory)) return run()
  return auditOperation({ actions: createFileActionLog(actionsPath(location)), workspaceId: NODE_SCOPE, tool: 'cli_service', sessionId: 'local-owner', ignoreWarning: input.ignoreWarning === true, isSuccessful: result => result.exitCode === 0, describe: result => result.detail, operation: run })
}

/** Each subcommand's options, read before anything runs, so a word it does not take is refused first. */
const OPTIONS: Record<string, ParseOptions> = {
  install: { now: { type: 'boolean' } },
  uninstall: {},
  start: {},
  stop: {},
  restart: {},
  status: { json: { type: 'boolean' } },
  logs: { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' } },
}

async function dispatch(context: ServiceContext, action: string, rest: string[]): Promise<CliResult> {
  const options = Object.hasOwn(OPTIONS, action) ? OPTIONS[action] : undefined
  if (options === undefined) {
    context.err(SERVICE_USAGE)
    return { exitCode: 1 }
  }
  try {
    const values = flags(rest, options)
    if (context.manager === null && DEFINITION_ACTIONS.has(action)) {
      context.err(`${unsupported(context.input.platform)}\n`)
      return { exitCode: UNSUPPORTED_EXIT }
    }
    if (action === 'install') return await install(context, values.now === true)
    if (action === 'status') return await status(context, values.json === true)
    if (action === 'logs') return await logs(context, { follow: values.follow === true, lines: typeof values.lines === 'string' ? values.lines : undefined })
    return await { uninstall, start, stop, restart }[action as 'uninstall' | 'start' | 'stop' | 'restart'](context)
  } catch (error) {
    if (error instanceof ServiceManagerError || error instanceof UsageError) return fail(context.err, error.message)
    throw error
  }
}

class UsageError extends Error {}

type ParseOptions = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>['options']>

function flags(argv: string[], options: ParseOptions): Record<string, string | boolean | undefined> {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false }).values as Record<string, string | boolean | undefined>
  } catch (error) {
    if (error instanceof TypeError && String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) throw new UsageError(`${error.message.split('. ')[0]}\n${SERVICE_USAGE.trimEnd()}`)
    throw error
  }
}

/** Where no service manager answers: the plain detach runs the node instead. */
const FALLBACK = 'buckle serve --background runs the node until it stops'

/** A platform Buckle drives no service manager on: one other than Linux, macOS, and Windows. */
function unsupported(platform: NodeJS.Platform): string {
  return `buckle service is not supported yet on ${platform}: ${FALLBACK}, and buckle service stop, status, and logs work on it.`
}

async function install(context: ServiceContext, now: boolean): Promise<CliResult> {
  const { location } = context
  const manager = context.manager!
  const unavailable = await manager.unavailable()
  if (unavailable !== null) return fail(context.err, `${unavailable}, so nothing was installed; ${FALLBACK}.`)
  if (!existsSync(location.environmentFile ?? defaultEnvironmentFile({ BUCKLE_STATE_DIR: location.stateDirectory }))) {
    return fail(context.err, 'This node is not set up yet, and a service reads its settings from its environment file: run buckle init first.')
  }
  if (!existsSync(context.input.mainScript)) return fail(context.err, 'A service runs the built Buckle, and this copy has no dist/main.js: build it first with pnpm build.')
  const installed = await manager.installed()
  const refusal = installed === null ? null : otherNode(installed)
  if (refusal !== null) return fail(context.err, refusal)
  const running = await runningNode(location.stateDirectory)
  if (now && running?.record?.manager === 'background') return fail(context.err, `${inBackground(running)}; stop it first with buckle service stop, then install again.`)
  if (now && running?.record?.manager === 'terminal') return fail(context.err, `${atTerminal(running)}, then run buckle service install --now again.`)
  // A manager with no restart of its own (Task Scheduler) starts the definition's node through a start that does nothing
  // while another serves, so the earlier install's node is asked to stop between writing the definition and starting it.
  const replace = now && !manager.restart && ownsNode(manager, running)
  // Before the definition names it, so every Buckle process on this state directory keeps it from tools.
  if (location.environmentFile !== null) await recordEnvironmentFile({ stateDirectory: location.stateDirectory, file: location.environmentFile })
  await manager.install(definitionFor(context), { now: now && !replace })
  if (!now) {
    context.out(`Installed the Buckle service (${manager.label}); it starts at every login. Start it now with buckle service start.\n`)
    return { exitCode: 0, detail: `install ${manager.kind}` }
  }
  if (replace) {
    const refusal = await askToStop(context, running)
    if (refusal !== null) return fail(context.err, `Installed the Buckle service (${manager.label}). ${refusal}`)
    await manager.start()
  }
  const record = await waitForNewRecord(location.stateDirectory, running?.record?.pid)
  if (record === null) return fail(context.err, `Installed the Buckle service (${manager.label}), and it has not listened within ${START_WAIT_MS / 1000} seconds; buckle service status and buckle service logs show what it is doing.`)
  context.out(`Installed and started the Buckle service (${manager.label}, pid ${record.pid}); it starts at every login.\n`)
  return { exitCode: 0, detail: `install --now ${manager.kind}` }
}

/** What a definition runs: this Node and this package's main.js, and where the node lives, as paths alone. */
function definitionFor(context: ServiceContext): ServiceDefinition {
  const path = context.input.environment.PATH
  return {
    node: process.execPath,
    main: context.input.mainScript,
    stateDirectory: context.location.stateDirectory,
    environmentFile: context.location.environmentFile,
    ...(path ? { path } : {}),
    ...(context.input.skipOwnerOnlyCheck ? { skipOwnerOnlyCheck: true } : {}),
  }
}

/** Whether a node serves under this manager's definition: its record names the manager, or it has not written one yet. */
function ownsNode(manager: ServiceManager, running: RunningNode | null): running is RunningNode {
  return running !== null && (running.record === null || running.record.manager === manager.kind)
}

/**
 * One service per machine (Phase 3, item 5): a definition for another state directory, or one Buckle cannot read,
 * refuses an install, naming neither path.
 */
function otherNode(installed: InstalledService): string | null {
  if (installed.thisNode === null) return 'A Buckle service is installed whose definition does not name its state directory, and this machine runs one service. Remove it with buckle service uninstall, then install again.'
  if (installed.thisNode) return null
  return 'A Buckle service for another state directory is installed, and this machine runs one service. Remove it with buckle service uninstall, then install this node\'s.'
}

async function uninstall(context: ServiceContext): Promise<CliResult> {
  const manager = context.manager!
  if (await manager.installed() === null) {
    context.out('No Buckle service is installed; nothing was removed.\n')
    return { exitCode: 0 }
  }
  // A manager that cannot signal the node asks it to stop first, so it closes cleanly before its definition goes. A node
  // another manager started (a serve at a terminal, or by hand with --background) is not the definition's, and stays.
  const running = await runningNode(context.location.stateDirectory)
  if (!manager.stop && ownsNode(manager, running)) {
    const refusal = await askToStop(context, running)
    if (refusal !== null) return fail(context.err, refusal)
  }
  await manager.uninstall()
  context.out(`Removed the Buckle service (${manager.label}); the state directory is kept.\n`)
  return { exitCode: 0, detail: `uninstall ${manager.kind}` }
}

async function start(context: ServiceContext): Promise<CliResult> {
  const { location } = context
  const manager = context.manager!
  const running = await runningNode(location.stateDirectory)
  const installed = await manager.installed()
  if (installed === null) {
    if (running?.record?.manager === 'terminal') return fail(context.err, `No Buckle service is installed. ${atTerminal(running)}.`)
    if (running !== null) return fail(context.err, `No Buckle service is installed. ${inBackground(running)}.`)
    return fail(context.err, `No Buckle service is installed: buckle service install installs one, and ${FALLBACK}.`)
  }
  if (running?.record?.manager === 'background') return fail(context.err, `${inBackground(running)}; stop it first with buckle service stop.`)
  if (running?.record?.manager === 'terminal') return fail(context.err, `${atTerminal(running)}, then run buckle service start again.`)
  if (running !== null) {
    context.out(`The Buckle service is already running${pidOf(running)}.\n`)
    return { exitCode: 0 }
  }
  const missing = missingPrograms(installed)
  if (missing !== null) return fail(context.err, missing)
  await manager.start()
  return reportStarted(context, { verb: 'Started', detail: 'start' })
}

async function stop(context: ServiceContext): Promise<CliResult> {
  const running = await runningNode(context.location.stateDirectory)
  if (running === null) return stopDefinition(context)
  // A serve at a terminal stops there: Buckle asks nothing of it (fix brief 6, item 1).
  if (running.record?.manager === 'terminal') return fail(context.err, `${atTerminal(running)}.`)
  const { manager } = context
  if (manager?.stop && running.record?.manager === manager.kind) {
    await manager.stop()
    if (!await waitForStop(context.location.stateDirectory, STOP_WAIT_MS)) return fail(context.err, `Buckle${pidOf(running)} did not stop within ${STOP_WAIT_MS / 1000} seconds; buckle service logs shows what it is doing.`)
    context.out(`Stopped Buckle${pidOf(running)}.\n`)
    return { exitCode: 0, detail: `stop ${manager.kind}` }
  }
  const refusal = await askToStop(context, running)
  if (refusal !== null) return fail(context.err, refusal)
  context.out(`Stopped Buckle${pidOf(running)}.\n`)
  return { exitCode: 0, detail: `stop ${running.record!.manager}` }
}

/**
 * No node holds the serve lock. A definition for this node whose node fails at every start holds it only while that node
 * runs, and the manager starts it again after each failure, so stopping the definition is what ends the tries. A manager
 * with no stop of its own (Task Scheduler), and a definition for another state directory or one that names none, are
 * left alone: there is nothing running to stop.
 */
async function stopDefinition(context: ServiceContext): Promise<CliResult> {
  const { manager } = context
  if (manager?.stop && (await manager.installed())?.thisNode === true) {
    await manager.stop()
    context.out(`Stopped the Buckle service (${manager.label}); no node was running.\n`)
    return { exitCode: 0, detail: `stop ${manager.kind}` }
  }
  context.out('Buckle is not running.\n')
  return { exitCode: 0 }
}

/**
 * Asks the running node to stop through its stop request, which it polls for, and waits for it to end: the way to stop
 * a node Windows' Task Scheduler or --background started, as neither delivers SIGTERM. Why it did not stop, or null
 * once it has, or where none runs.
 */
async function askToStop(context: ServiceContext, running: RunningNode | null): Promise<string | null> {
  if (running === null) return null
  if (running.record === null) return 'Buckle is still starting; run buckle service stop again in a moment.'
  await requestStop(context.location.stateDirectory, running.record.pid)
  if (await waitForStop(context.location.stateDirectory, STOP_WAIT_MS)) return null
  return `Buckle${pidOf(running)} did not stop within ${STOP_WAIT_MS / 1000} seconds; buckle service logs shows what it is doing.`
}

async function restart(context: ServiceContext): Promise<CliResult> {
  const { location } = context
  const manager = context.manager!
  const running = await runningNode(location.stateDirectory)
  const installed = await manager.installed()
  if (installed === null) {
    if (running?.record?.manager === 'background') return fail(context.err, `No Buckle service is installed to restart. ${inBackground(running)}: stop it with buckle service stop, then start it again with buckle serve --background.`)
    if (running?.record?.manager === 'terminal') return fail(context.err, `No Buckle service is installed to restart. ${atTerminal(running)}, then run buckle serve again.`)
    return fail(context.err, `No Buckle service is installed to restart: buckle service install installs one, and ${FALLBACK}.`)
  }
  if (running?.record?.manager === 'background') return fail(context.err, `${inBackground(running)}; stop it first with buckle service stop.`)
  if (running?.record?.manager === 'terminal') return fail(context.err, `${atTerminal(running)}, then run buckle service start.`)
  const missing = missingPrograms(installed)
  if (missing !== null) return fail(context.err, missing)
  const before = running?.record?.pid
  if (manager.restart) await manager.restart()
  else {
    const refusal = await askToStop(context, running)
    if (refusal !== null) return fail(context.err, refusal)
    await manager.start()
  }
  return reportStarted(context, { verb: 'Restarted', detail: 'restart', before })
}

/** Waits for the node a start began to listen, a pid other than `before`, and says so in one line. */
async function reportStarted(context: ServiceContext, step: { verb: string; detail: string; before?: number | undefined }): Promise<CliResult> {
  const { manager, location } = context
  const record = await waitForNewRecord(location.stateDirectory, step.before)
  if (record === null) return fail(context.err, `Asked ${manager!.label} to start, and Buckle has not listened within ${START_WAIT_MS / 1000} seconds; buckle service status and buckle service logs show what it is doing.`)
  context.out(`${step.verb} the Buckle service (pid ${record.pid}) at ${addressOf(record)}.\n`)
  return { exitCode: 0, detail: `${step.detail} ${manager!.kind}` }
}

/** The record of a node that holds the serve lock now, under a pid other than `before`, once one listens; null after the wait. */
async function waitForNewRecord(stateDirectory: string, before: number | undefined): Promise<ServeRecord | null> {
  const deadline = Date.now() + START_WAIT_MS
  for (;;) {
    const record = (await runningNode(stateDirectory))?.record ?? null
    if (record !== null && record.pid !== before) return record
    if (Date.now() >= deadline) return null
    await delay(100)
  }
}

/**
 * A definition naming a Node binary or main.js that is gone, as after Node moved under a version manager such as nvm:
 * the service would fail at every start, so it says to install again.
 */
function missingPrograms(installed: InstalledService): string | null {
  const gone = [installed.node === null || existsSync(installed.node) ? null : 'Node binary', installed.main === null || existsSync(installed.main) ? null : 'Buckle main.js'].filter(item => item !== null)
  if (gone.length === 0) return null
  return `The Buckle service runs a ${gone.join(' and a ')} that is no longer there, as after Node is upgraded or moved; run buckle service install again.`
}

/**
 * `buckle service status` (Phase 3, item 6): the definition and whether it starts at login, the node running and how it
 * was started, whether it answers /health and /health/ready (which need no token), the running version against the
 * installed one, and what to do next: restart after an upgrade, install again after Node moved, or, on Linux, the
 * system's own command that starts it before login.
 */
async function status(context: ServiceContext, json: boolean): Promise<CliResult> {
  const { manager, location } = context
  const installed = manager === null ? null : await manager.installed()
  const running = await runningNode(location.stateDirectory)
  const record = running?.record ?? null
  const health = record === null ? null : await probeHealth(addressOf(record))
  const installedVersion = versionOf(installed?.main ?? context.input.mainScript)
  const beforeLogin = installed !== null && manager?.beforeLogin ? await manager.beforeLogin() : null
  const missing = installed === null ? null : missingPrograms(installed)
  const next = [
    ...(missing === null ? [] : [missing]),
    ...(record !== null && installedVersion !== null && record.version !== installedVersion ? [`The node runs ${record.version} and ${installedVersion} is installed: ${upgradeStep(record)}.`] : []),
    ...(beforeLogin !== null && !beforeLogin.starts ? [`It starts at login. To start it at boot, before anyone logs in, the system's own setting is: ${beforeLogin.command} (Buckle does not run it; it may ask for an administrator's password).`] : []),
  ]
  const report = {
    platform: context.input.platform,
    manager: manager?.kind ?? null,
    definition: installed === null ? null : { label: manager!.label, enabled: installed.enabled, thisNode: installed.thisNode === true, ...(beforeLogin === null ? {} : { startsBeforeLogin: beforeLogin.starts }), ...(installed.skipsOwnerOnlyCheck ? { skipsOwnerOnlyCheck: true } : {}) },
    running: running === null ? null : { pid: record?.pid ?? null, startedBy: record?.manager ?? null, address: record === null ? null : addressOf(record), version: record?.version ?? null, startedAt: record?.startedAt ?? null, health },
    installedVersion,
    next,
  }
  if (json) {
    context.out(`${JSON.stringify(report, null, 2)}\n`)
    return { exitCode: 0 }
  }
  context.out(`Service    ${report.definition === null ? (manager === null ? `none: ${unsupported(context.input.platform)}` : 'not installed') : `${report.definition.label}, ${report.definition.enabled ? 'starts at login' : 'disabled'}${report.definition.thisNode ? '' : ', for another state directory'}${report.definition.skipsOwnerOnlyCheck ? `, started with ${SKIP_OWNER_ONLY_FLAG}` : ''}`}\n`)
  context.out(`Running    ${running === null ? 'no' : `yes${pidOf(running)}${record === null ? ', starting' : `, started by ${startedBy(record)} at ${record.startedAt}`}`}\n`)
  if (record !== null && health !== null) {
    context.out(`Address    ${addressOf(record)}\nHealth     ${health.live ? '/health answers' : '/health does not answer'}; ${health.ready === 200 ? '/health/ready answers ready' : health.ready === null ? '/health/ready does not answer' : `/health/ready answers ${health.ready}, not ready yet`}\n`)
  }
  context.out(`Version    ${record === null ? '' : `${record.version} running, `}${installedVersion ?? 'unknown'} installed\n`)
  for (const line of next) context.out(`Next       ${line}\n`)
  return { exitCode: 0 }
}

/** How long status waits for each health probe. */
const PROBE_MS = 2_000

/** Whether the node answers its liveness probe, and the status its readiness probe gives; both need no token. */
async function probeHealth(address: string): Promise<{ live: boolean; ready: number | null }> {
  const status = (path: string) => fetch(`${address}${path}`, { signal: AbortSignal.timeout(PROBE_MS) }).then(response => response.status, () => null)
  const [live, ready] = await Promise.all([status('/health'), status('/health/ready')])
  return { live: live === 200, ready }
}

/** The version of the package whose dist/main.js this is, read from its package.json now; null where it cannot be read. */
function versionOf(main: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dirname(dirname(main)), 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

function startedBy(record: ServeRecord): string {
  return { background: 'buckle serve --background', terminal: 'buckle serve at a terminal', systemd: 'systemd', launchd: 'launchd', 'task-scheduler': 'Task Scheduler' }[record.manager]
}

/** How the running node picks up a newer install: as what started it restarts it. */
function upgradeStep(record: ServeRecord): string {
  if (record.manager === 'background') return 'stop it with buckle service stop, then start it again with buckle serve --background'
  if (record.manager === 'terminal') return 'stop it with Ctrl-C at its terminal, then run buckle serve again'
  return 'run buckle service restart'
}

async function logs(context: ServiceContext, options: { follow: boolean; lines: string | undefined }): Promise<CliResult> {
  if (options.lines !== undefined && !/^\d{1,9}$/.test(options.lines)) return fail(context.err, '-n takes a count of lines, 0 or more')
  const count = options.lines === undefined ? DEFAULT_LOG_LINES : Number(options.lines)
  let view: LogView
  try { view = logView(context) } catch (error) { return fail(context.err, error instanceof Error ? error.message : String(error)) }
  const file = serviceLogPath(context.location.stateDirectory)
  if (!existsSync(file) && !options.follow) {
    context.out('No service log yet: a node writes it once it runs under buckle service or buckle serve --background.\n')
    return { exitCode: 0 }
  }
  let offset = 0
  if (existsSync(file)) {
    // Whole lines alone: a line the node is still writing is left to follow(), which prints it once it ends (fix brief 1, H5).
    const bytes = readFileSync(file)
    offset = bytes.lastIndexOf(10) + 1
    const lines = bytes.subarray(0, offset).toString('utf8').split('\n').filter(Boolean)
    if (count > 0) context.out(view.last(lines, count))
  }
  if (!options.follow) return { exitCode: 0 }
  await follow(context, file, offset, view.added)
  return { exitCode: 0 }
}

/** What `logs` prints of the file: its last lines, and then what it gains, which share one state (the date separators). */
interface LogView {
  /** The last `count` of the whole lines the file holds. */
  last(lines: string[], count: number): string
  /** Whole lines the file gained, as text. */
  added(text: string): string
}

/**
 * How `logs` prints what the file stores (C6): as a serve's console shows it, in this device's local time with date
 * separators across what it prints, where its output is a terminal, and then `-n` counts the entries it shows, not the
 * stored lines; as stored where it is piped, or where BUCKLE_LOG_FORMAT, read from the shell before buckle.env is, says
 * json, and then `-n` counts stored lines. The file itself stays JSON lines in UTC.
 */
function logView(context: ServiceContext): LogView {
  const format = logFormatFrom(context.input.environment) ?? (context.input.stdoutIsTerminal === true ? 'human' : 'json')
  if (format === 'json') return { last: (lines, count) => lines.slice(-count).map(line => `${line}\n`).join(''), added: text => text }
  const render = createStoredLineRenderer({ verbose: false })
  const printed = (rows: string[]) => rows.map(row => `${row}\n`).join('')
  return { last: (lines, count) => printed(render.last(lines, count)), added: text => printed(text.split('\n').filter(Boolean).flatMap(render)) }
}

/**
 * Prints what the log gains until the signal ends it: lines added since the last look, and, after the file rotates
 * (it was renamed and a new one begun), the new file from its start.
 */
async function follow(context: ServiceContext, file: string, from: number, shown: (text: string) => string): Promise<void> {
  let offset = from
  let inode = existsSync(file) ? statSync(file).ino : null
  const signal = context.input.signal
  while (!signal?.aborted) {
    await delay(FOLLOW_POLL_MS, undefined, signal ? { signal } : {}).catch(() => undefined)
    if (signal?.aborted || !existsSync(file)) continue
    const stats = statSync(file)
    if (stats.ino !== inode || stats.size < offset) {
      inode = stats.ino
      offset = 0
    }
    if (stats.size === offset) continue
    const added = readFileSync(file).subarray(offset)
    const complete = added.lastIndexOf(10) + 1
    if (complete === 0) continue
    context.out(shown(added.subarray(0, complete).toString('utf8')))
    offset += complete
  }
}

function inBackground(running: RunningNode): string {
  return `A node runs in the background${pidOf(running)}, started by buckle serve --background`
}

function pidOf(running: RunningNode): string {
  return running.record === null ? '' : ` (pid ${running.record.pid})`
}

function fail(err: (text: string) => void, message: string): CliResult {
  err(`${message}\n`)
  return { exitCode: 1 }
}
