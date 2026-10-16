import { existsSync, readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath } from '../common/runtime/config.js'
import { defaultEnvironmentFile, nodeLocation } from '../common/runtime/environment.js'
import { addressOf } from '../common/services/node-service/attach.js'
import { requestStop, runningNode, serviceLogPath, waitForStop, type RunningNode, type ServeRecord } from '../common/services/node-service/serve-record.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { NODE_SCOPE } from '../common/types/ports/client-keys.js'
import type { ProcessRunner } from '../common/types/ports/process-runner.js'
import { ServiceManagerError, type InstalledService, type NodeLocation, type ServiceDefinition, type ServiceManager } from '../common/types/ports/service-manager.js'

export interface CliResult {
  exitCode: number
  /** For the command's audit entry. */
  detail?: string
}

export const SERVICE_USAGE = `Usage: buckle service install [--now] | uninstall | start | stop | restart | status [--json] | logs [-f] [-n <lines>]

Runs this machine's node with no terminal, starting at login: a systemd user unit on Linux, a Task Scheduler task
on Windows (docs/service.md). One node per machine. install writes the definition and enables it, and --now starts
it too; uninstall stops it and removes the definition, keeping the state directory. Where no service manager answers,
buckle serve --background runs the node until it stops, and stop, status, and logs work on that node too.
`

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
 * The exit code where Buckle drives no service manager on this platform (Q12: nothing for macOS yet), so a script can
 * tell "not supported here" from a refusal.
 */
export const UNSUPPORTED_EXIT = 2

/**
 * `buckle service` (Phase 3 of the workspace-model slice), dispatched before buckle.env is read, so no credential is in
 * this process's environment when it starts a service manager's program, and each program gets an environment built
 * from a fixed list besides. A change is audited in the node's log, where the node has a state directory.
 */
export async function serviceCommand(input: ServiceCommandInput): Promise<CliResult> {
  const out = input.out ?? (text => void process.stdout.write(text))
  const err = input.err ?? (text => void process.stderr.write(text))
  const [action, ...rest] = input.argv
  if (action === undefined || action === 'help' || action === '--help' || action === '-h') {
    ;(action === undefined ? err : out)(SERVICE_USAGE)
    return { exitCode: action === undefined ? 1 : 0 }
  }
  let location: NodeLocation
  try { location = nodeLocation(input.environment, input.platform) } catch (error) { return fail(err, error instanceof Error ? error.message : String(error)) }
  const context: ServiceContext = { location, manager: input.manager(location), input, out, err }
  const run = () => dispatch(context, action, rest)
  if (!AUDITED.has(action) || !existsSync(location.stateDirectory)) return run()
  return auditOperation({ actions: createFileActionLog(actionsPath(location)), workspaceId: NODE_SCOPE, tool: 'cli_service', sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, describe: result => result.detail, operation: run })
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

/** Phase 3, item 4 (Q12): nothing for macOS yet, nor for a platform Buckle drives no service manager on. */
function unsupported(platform: NodeJS.Platform): string {
  return `buckle service is not supported yet on ${platform === 'darwin' ? 'macOS' : platform}: ${FALLBACK}, and buckle service stop, status, and logs work on it.`
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
  await manager.install(definitionFor(context), { now })
  if (!now) {
    context.out(`Installed the Buckle service (${manager.label}); it starts at every login. Start it now with buckle service start.\n`)
    return { exitCode: 0, detail: `install ${manager.kind}` }
  }
  const record = await waitForNewRecord(location.stateDirectory, undefined)
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
  }
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
  // A manager that cannot signal the node asks it to stop first, so it closes cleanly before its definition goes.
  if (!manager.stop) {
    const refusal = await askToStop(context, await runningNode(context.location.stateDirectory))
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
    if (running !== null) return fail(context.err, `No Buckle service is installed. ${inBackground(running)}.`)
    return fail(context.err, `No Buckle service is installed: buckle service install installs one, and ${FALLBACK}.`)
  }
  if (running?.record?.manager === 'background') return fail(context.err, `${inBackground(running)}; stop it first with buckle service stop.`)
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
  if (running === null) {
    context.out('Buckle is not running.\n')
    return { exitCode: 0 }
  }
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
    return fail(context.err, `No Buckle service is installed to restart: buckle service install installs one, and ${FALLBACK}.`)
  }
  if (running?.record?.manager === 'background') return fail(context.err, `${inBackground(running)}; stop it first with buckle service stop.`)
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

async function status(context: ServiceContext, json: boolean): Promise<CliResult> {
  const { manager, location } = context
  const installed = manager === null ? null : await manager.installed()
  const running = await runningNode(location.stateDirectory)
  const report = {
    platform: context.input.platform,
    manager: manager?.kind ?? null,
    definition: installed === null ? null : { label: manager!.label, enabled: installed.enabled, thisNode: installed.thisNode === true },
    running: running === null ? null : { pid: running.record?.pid ?? null, startedBy: running.record?.manager ?? null, address: running.record === null ? null : addressOf(running.record), version: running.record?.version ?? null, startedAt: running.record?.startedAt ?? null },
  }
  if (json) {
    context.out(`${JSON.stringify(report, null, 2)}\n`)
    return { exitCode: 0 }
  }
  context.out(`Service    ${report.definition === null ? (manager === null ? `none: ${unsupported(context.input.platform)}` : 'not installed') : `${report.definition.label}, ${report.definition.enabled ? 'starts at login' : 'disabled'}${report.definition.thisNode ? '' : ', for another state directory'}`}\n`)
  context.out(`Running    ${running === null ? 'no' : `yes${pidOf(running)}${running.record === null ? ', starting' : `, started by ${startedBy(running.record)} at ${running.record.startedAt}`}`}\n`)
  if (running?.record) context.out(`Address    ${addressOf(running.record)}\nVersion    ${running.record.version}\n`)
  return { exitCode: 0 }
}

function startedBy(record: ServeRecord): string {
  return record.manager === 'background' ? 'buckle serve --background' : record.manager === 'systemd' ? 'systemd' : 'Task Scheduler'
}

async function logs(context: ServiceContext, options: { follow: boolean; lines: string | undefined }): Promise<CliResult> {
  if (options.lines !== undefined && !/^\d{1,9}$/.test(options.lines)) return fail(context.err, '-n takes a count of lines, 0 or more')
  const count = options.lines === undefined ? DEFAULT_LOG_LINES : Number(options.lines)
  const file = serviceLogPath(context.location.stateDirectory)
  if (!existsSync(file) && !options.follow) {
    context.out('No service log yet: a node writes it once it runs under buckle service or buckle serve --background.\n')
    return { exitCode: 0 }
  }
  let offset = 0
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    offset = Buffer.byteLength(text)
    const lines = text.split('\n').filter(Boolean)
    if (count > 0) context.out(lines.slice(-count).map(line => `${line}\n`).join(''))
  }
  if (!options.follow) return { exitCode: 0 }
  await follow(context, file, offset)
  return { exitCode: 0 }
}

/**
 * Prints what the log gains until the signal ends it: lines added since the last look, and, after the file rotates
 * (it was renamed and a new one begun), the new file from its start.
 */
async function follow(context: ServiceContext, file: string, from: number): Promise<void> {
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
    context.out(added.subarray(0, complete).toString('utf8'))
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
