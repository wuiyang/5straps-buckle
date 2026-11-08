import type { LogPushOptions } from './log-queue.js'

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevel = typeof LOG_LEVELS[number]
export type LogFields = Record<string, unknown>

export interface NormalizedError {
  name: string
  message: string
  code?: string | number
  stack?: string
  cause?: NormalizedError
  errors?: NormalizedError[]
  repeated?: true
}

export interface LogEvent {
  timestamp: string
  level: LogLevel
  component: string
  message: string
  correlationId?: string
  fields?: Record<string, unknown>
  error?: NormalizedError
}

export interface LogSink {
  readonly name: string
  write(event: LogEvent): void | Promise<void>
  flush?(): void | Promise<void>
  close?(): void | Promise<void>
}

/** `options.expendable`: for a line anyone can make the process write, such as one per request it answers. */
export type LogMethod = (message: string, fields?: LogFields, options?: LogPushOptions) => void

export interface Logger {
  trace: LogMethod
  debug: LogMethod
  info: LogMethod
  /** Alias of info. */
  log: LogMethod
  warn: LogMethod
  error: LogMethod
  /** Records fatal severity only; the caller decides whether to shut down. */
  fatal: LogMethod
  child(bindings: LogFields & { component?: string }): Logger
}

export function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level)
}
