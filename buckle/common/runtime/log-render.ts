import type { LogEvent, LogLevel, NormalizedError } from '@5straps/runtime'
import { printable } from '../domain/approval-instruction.js'
import { localDate, localTime } from '../domain/local-time.js'

/**
 * How much a person at the terminal asked to see: at debug or trace (`verbose`), every startup and shutdown step, each
 * event's correlation id, and each error's stack.
 */
export interface RenderOptions {
  verbose: boolean
}

/** The log is at debug or trace. */
export function isVerbose(level: LogLevel): boolean {
  return level === 'debug' || level === 'trace'
}

/** Startup and shutdown steps: the JSON keeps every one; a person sees them at debug or trace. */
const STEP_MESSAGES: ReadonlySet<string> = new Set(['cli:call listener registered', 'close step'])

/** How a request that ended well reads in `request completed`, which then says nothing of its outcome. */
const GOOD_OUTCOME = /^(?:ok|streamed)(?: [23]\d\d)?$/

/** One event as a known message words it: its tag, its text, and the fields it did not already say. */
interface Shown {
  tag: string
  text: string
  fields: Record<string, unknown>
}

/**
 * One log event as the lines a person reads at a terminal (the CLI display slice, C2), or null where the console leaves
 * it to the JSON: `22:22:00 [info] message key=value`, the time on this device's clock from the event's own timestamp,
 * the level in lower case, and no component column. An error follows the message as `Name: message (code)`, with its
 * stack indented below at fatal, or at every level when verbose; a value of several lines goes on indented lines of its
 * own, and an object on one line as JSON. Every piece of text passes through printable(), so the console is never
 * weaker than the JSON line, which leaves DEL, C1, and bidi characters raw. The JSON a machine reads is unchanged.
 */
export function renderEvent(event: LogEvent, options: RenderOptions): string[] | null {
  if (STEP_MESSAGES.has(event.message) && !options.verbose) return null
  const shown = shownEvent(event, options)
  if (shown === null) return null
  const fields = Object.entries(shown.fields).filter(([, value]) => value !== undefined)
  const inline = fields.filter(([, value]) => !multiline(value)).map(([key, value]) => ` ${printable(key)}=${scalar(value)}`)
  const blocks = fields.filter(([, value]) => multiline(value)).flatMap(([key, value]) => [`  ${printable(key)}:`, ...String(value).split(/\r?\n/).map(line => `    ${printable(line)}`)])
  const correlation = options.verbose && event.correlationId ? ` correlationId=${printable(event.correlationId)}` : ''
  const error = event.error ? `: ${errorLine(event.error)}` : ''
  const stack = event.error && (event.level === 'fatal' || options.verbose) ? stackLines(event.error) : []
  return [`${localTime(new Date(event.timestamp))} [${shown.tag}] ${shown.text}${error}${inline.join('')}${correlation}`, ...blocks, ...stack]
}

/**
 * `--- 2026-10-21 ---` before the first line, and again before any line whose local date is not the last one's: one
 * state per console, so a day that falls back an hour still reads as one day.
 */
export function createDateSeparators(): (at: Date) => string[] {
  let last: string | undefined
  return (at) => {
    const date = localDate(at)
    if (date === last) return []
    last = date
    return [`--- ${date} ---`]
  }
}

function shownEvent(event: LogEvent, options: RenderOptions): Shown | null {
  const fields = event.fields ?? {}
  if (event.message === 'request completed') return requestCompleted(event, fields, options)
  if (event.message === 'request finished') return requestFinished(event, fields, options)
  return { tag: event.level, text: printable(event.message), fields }
}

/**
 * The runtime's line for a request its guards let in, as the owner's example reads: `/mcp request completed (159ms)`,
 * with how it ended where that was not well. The path is the caller's, so it is escaped.
 */
function requestCompleted(event: LogEvent, fields: Record<string, unknown>, options: RenderOptions): Shown {
  const { path, outcome, durationMs, ...rest } = fields
  if (typeof path !== 'string' || typeof durationMs !== 'number') return { tag: event.level, text: printable(event.message), fields }
  const ended = typeof outcome === 'string' && !GOOD_OUTCOME.test(outcome) ? `, ${printable(outcome)}` : ''
  return { tag: event.level, text: `${printable(path)} request completed (${durationMs}ms)${ended}`, fields: options.verbose ? rest : {} }
}

/**
 * Buckle's own line for every request, path-free (B19). Its operation twin, `request completed`, already says a request
 * with an actor, so only one that ran no operation shows: a refusal by a guard (a wrong token, a node not ready), an
 * unrouted path, a probe. `/mcp 401 (2ms)`.
 */
function requestFinished(event: LogEvent, fields: Record<string, unknown>, options: RenderOptions): Shown | null {
  if (fields.actor !== undefined) return null
  const { route, status, durationMs, ...rest } = fields
  return { tag: event.level, text: `${typeof route === 'string' ? printable(route) : 'no route'} ${scalar(status)} (${scalar(durationMs)}ms)`, fields: options.verbose ? rest : {} }
}

function multiline(value: unknown): value is string {
  return typeof value === 'string' && value.includes('\n')
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return printable(value)
  if (typeof value === 'object' && value !== null) return printable(JSON.stringify(value))
  return String(value)
}

function errorLine(error: NormalizedError): string {
  return `${printable(error.name)}${error.message ? `: ${printable(error.message)}` : ''}${error.code === undefined ? '' : ` (${printable(String(error.code))})`}`
}

/** The stack's frames, indented, without the first line where it only repeats the name and message. */
function stackLines(error: NormalizedError): string[] {
  if (!error.stack) return []
  const lines = error.stack.split(/\r?\n/)
  const frames = lines[0] === `${error.name}${error.message ? `: ${error.message}` : ''}` ? lines.slice(1) : lines
  return frames.filter(line => line.trim() !== '').map(line => `    ${printable(line.trim())}`)
}
