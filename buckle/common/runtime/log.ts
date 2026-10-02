import { createLogger, createStderrJsonSink, LOG_LEVELS, type Logger, type LoggerConfig, type LoggerRoot, type LogLevel } from '@5straps/runtime'
import { parseList } from './config.js'

const COMPONENT = 'buckle'
// Created on first use with the defaults, until main configures it from the environment.
let root: LoggerRoot | undefined

/**
 * The process's root logger, on the runtime logger: seven levels, child bindings, redaction of
 * secrets and content keys, and a stderr JSON sink (stdout stays for machine output and MCP frames).
 */
export const logger: Logger = delegate(() => rootLogger().logger)

export function rootLogger(): LoggerRoot {
  root ??= createRoot({})
  return root
}

/** Main calls this once, before anything else logs; a default root made earlier is flushed and replaced. */
export function configureRootLogger(config: LoggerConfig): LoggerRoot {
  const previous = root
  root = createRoot(config)
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

function createRoot(config: LoggerConfig): LoggerRoot {
  return createLogger({ ...config, component: COMPONENT, sinks: [createStderrJsonSink()] })
}

// Resolved on every call, so a logger taken at import time follows the root main configures later.
function delegate(resolve: () => Logger): Logger {
  return {
    trace: (message, fields) => resolve().trace(message, fields),
    debug: (message, fields) => resolve().debug(message, fields),
    info: (message, fields) => resolve().info(message, fields),
    log: (message, fields) => resolve().log(message, fields),
    warn: (message, fields) => resolve().warn(message, fields),
    error: (message, fields) => resolve().error(message, fields),
    fatal: (message, fields) => resolve().fatal(message, fields),
    child: bindings => delegate(() => resolve().child(bindings)),
  }
}
