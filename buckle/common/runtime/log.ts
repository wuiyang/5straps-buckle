import { once } from 'node:events'
import { createLogger, createRotatingFileSink, createStderrJsonSink, LOG_LEVELS, type LogFields, type Logger, type LoggerConfig, type LoggerRoot, type LogLevel, type LogSink } from '@5straps/runtime'
import { maskHeld, maskHeldJson, masksHeld } from '../services/secrets/mask.js'
import { parseList } from './config.js'
import { createConsoleWriter, type ConsoleWriter } from './console.js'
import { LOG_RETRY_DELAYS_MS, processLogBudget } from './log-budget.js'
import { isVerbose, renderEvent } from './log-render.js'

const COMPONENT = 'buckle'
/** The service log's bounds: five files of about 10 MiB, so a node left running for months keeps its disk use bounded. */
const LOG_FILE_MAX_BYTES = 10 * 1_048_576
const LOG_FILE_MAX_FILES = 5
// Created on first use with the defaults, until main configures it from the environment.
let root: LoggerRoot | undefined

/**
 * The process's root logger, on the runtime logger: seven levels, child bindings, redaction of
 * secrets and content keys, and a stderr sink, JSON or human lines (stdout stays for machine output and MCP frames).
 * Its lines are held under the process's one log budget and retried as every log of the process is (log-budget.ts).
 */
export const logger: Logger = delegate(() => rootLogger().logger)

export function rootLogger(): LoggerRoot {
  root ??= createRoot({})
  return root
}

/**
 * How stderr's log lines read (the CLI display slice, C1): JSON for a machine, and human lines in this device's local
 * time for a person at a terminal. The rotating service file is JSON whatever this says.
 */
export type LogFormat = 'json' | 'human'
const LOG_FORMATS: readonly LogFormat[] = ['json', 'human']

/**
 * Where the process's log lines go: stderr, or, for a node running with no terminal (`buckle service`, `buckle serve
 * --background`), the one rotating file under its state directory alone, which no agent tool reads (Phase 3, item 6).
 * Plain `stderr` takes its format by the TTY rule and the shell's BUCKLE_LOG_FORMAT, as every line logged before main
 * reads buckle.env does; main names the format once it has read the file, and a serve at a terminal hands in the
 * console writer its workspace list and approval questions share (C3). A worker thread hands in the sink that carries its
 * lines to the main thread's logger.
 */
export type LogOutput = { file: string } | 'stderr' | { format: LogFormat; console?: ConsoleWriter } | { sink: LogSink }

/** Main calls this once, before anything else logs; a default root made earlier is flushed and replaced. */
export function configureRootLogger(config: LoggerConfig, output: LogOutput = 'stderr'): LoggerRoot {
  const previous = root
  root = createRoot(config, output)
  void previous?.close()
  return root
}

/**
 * An error as a log line may carry it: its name, its own message and its own stack, never its cause, which the logger
 * would follow (slice 7 review R7-RR-3: a StateFileError's cause is the SyntaxError JSON.parse raised, and V8's
 * message quotes the state file around the fault). A SyntaxError's own message and stack quote the text it failed
 * on, so only its name is kept.
 */
export function withoutCause(error: unknown): Error | string {
  if (!(error instanceof Error)) return 'Unknown error'
  const quotes = error instanceof SyntaxError
  const kept = new Error(quotes ? '' : error.message)
  kept.name = error.name
  kept.stack = quotes ? `${error.name}` : error.stack
  return kept
}

/** Log events are written asynchronously; a caller about to read stderr or exit flushes first. */
export function flushLogs(): Promise<void> {
  return root?.flush() ?? Promise.resolve()
}

export function loggerConfigFrom(environment: NodeJS.ProcessEnv): LoggerConfig {
  const level = environment.BUCKLE_LOG_LEVEL?.trim()
  if (level && !LOG_LEVELS.includes(level as LogLevel)) throw new Error(`BUCKLE_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`)
  const omitKeys = parseList(environment.BUCKLE_LOG_OMIT_KEYS)
  const allowKeys = parseList(environment.BUCKLE_LOG_ALLOW_KEYS)
  return {
    ...(level ? { level: level as LogLevel } : {}),
    ...(omitKeys.length ? { omitKeys } : {}),
    ...(allowKeys.length ? { allowKeys } : {}),
  }
}

/**
 * BUCKLE_LOG_FORMAT, the one override of the TTY rule (C1), set in the shell or buckle.env: json or human; undefined where
 * unset. Read apart from loggerConfigFrom, as the logger's own config is the runtime's and carries no format.
 */
export function logFormatFrom(environment: NodeJS.ProcessEnv): LogFormat | undefined {
  const format = environment.BUCKLE_LOG_FORMAT?.trim()
  if (!format) return undefined
  if (!LOG_FORMATS.includes(format as LogFormat)) throw new Error('BUCKLE_LOG_FORMAT must be json or human')
  return format as LogFormat
}

/**
 * The format stderr's lines take: the override where one is set, else human where stderr is a terminal and JSON where
 * it is not, so every pipe, test, service, and MCP client reads the JSON it read before (C1).
 */
export function stderrFormat(override: LogFormat | undefined, stream: { isTTY?: boolean } = process.stderr): LogFormat {
  return override ?? (stream.isTTY === true ? 'human' : 'json')
}

function createRoot(config: LoggerConfig, output: LogOutput = 'stderr'): LoggerRoot {
  return createLogger({ ...config, component: COMPONENT, sinks: [sinkFor(output, config.level ?? 'info')], budget: processLogBudget, retryDelaysMs: LOG_RETRY_DELAYS_MS })
}

function sinkFor(output: LogOutput, level: LogLevel): LogSink {
  if (typeof output === 'object' && 'sink' in output) return output.sink
  if (typeof output === 'object' && 'file' in output) return createRotatingFileSink({ path: output.file, maxBytes: LOG_FILE_MAX_BYTES, maxFiles: LOG_FILE_MAX_FILES })
  const chosen = output === 'stderr' ? { format: stderrFormat(shellFormat()) } : output
  if (chosen.format === 'json') return createStderrJsonSink()
  // A one-shot command's lines carry the time and no date separator; a serve's console writes the separator.
  return createHumanSink({ console: chosen.console ?? createConsoleWriter({ output: process.stderr, dates: false }), level })
}

/** Before main reads buckle.env, the shell's override where it names a format; main itself refuses any other value. */
function shellFormat(): LogFormat | undefined {
  try {
    return logFormatFrom(process.env)
  } catch {
    return undefined
  }
}

/**
 * Human lines on stderr through a console writer, at debug or trace with every step and stack. Never held for an open
 * question: the writer draws the line above its prompt. A sink that fails leaves the logger's fallback line, which
 * stays JSON.
 */
function createHumanSink(input: { console: ConsoleWriter; level: LogLevel }): LogSink {
  const options = { verbose: isVerbose(input.level) }
  return {
    name: 'stderr-human',
    async write(event) {
      const lines = renderEvent(event, options)
      if (lines !== null && !input.console.write(lines, new Date(event.timestamp))) await once(input.console.output, 'drain')
    },
  }
}

/**
 * Resolved on every call, so a logger taken at import time follows the root main configures later. While a call holds
 * secret values, each line is masked as it is logged, before any sink queues it (docs/user/how-to/secrets.md); a child's bindings
 * are masked as they are bound.
 */
function delegate(resolve: () => Logger): Logger {
  const line = (method: 'trace' | 'debug' | 'info' | 'log' | 'warn' | 'error' | 'fatal') => (message: string, fields?: LogFields) => {
    if (!masksHeld()) return resolve()[method](message, fields)
    return resolve()[method](maskHeld(message), fields === undefined ? undefined : maskHeldJson(fields))
  }
  return {
    trace: line('trace'),
    debug: line('debug'),
    info: line('info'),
    log: line('log'),
    warn: line('warn'),
    error: line('error'),
    fatal: line('fatal'),
    child: (bindings) => {
      const bound = masksHeld() ? maskHeldJson(bindings) : bindings
      return delegate(() => resolve().child(bound))
    },
  }
}
