import { runDetached, sinkStorage } from '../internal/async-slots.js'
import { readOptionalTimer, readTimerList, settleWithin } from '../internal/timeouts.js'
import { useScopeSafe } from '../scope/als.js'
import { createLogBudget, createLogQueue, DEFAULT_LOG_LIMIT, type LogBudget, type LogDropNotice, type LogDrops, type LogPushOptions, type LogQueue } from './log-queue.js'
import { DEFAULT_MAX_STRING_BYTES, normalizeError, sanitizeFields, sanitizeString, truncateText, type SanitizeOptions } from './sanitize.js'
import { levelRank, LOG_LEVELS, type LogEvent, type LogFields, type Logger, type LogLevel, type LogSink, type NormalizedError } from './types.js'

// The serializable part of LoggerOptions, so a runtime config (environment or JSON) can carry it; checked at createLogger.
export interface LoggerConfig {
  level?: LogLevel
  /** Events held per logger when no budget is given; each sink's copy counts. */
  queueLimit?: number
  /** Waits before each further attempt at a failed sink write; none by default, so a failed event drops at once. */
  retryDelaysMs?: readonly number[]
  /** How long a sink write may take before it counts as failed (LogQueueOptions.writeDeadlineMs); none by default. */
  writeDeadlineMs?: number
  maxStringBytes?: number
  maxObjectKeys?: number
  // Serialized size of a whole event; an oversized event loses error detail first, then large fields.
  maxEventBytes?: number
  /** Keys exempt from content redaction; opt-in per deployment. Credential keys stay redacted whatever this lists. */
  allowKeys?: readonly string[]
  /** Extra keys whose values are omitted with their size, like file contents. */
  omitKeys?: readonly string[]
}

export interface LoggerOptions extends LoggerConfig {
  component: string
  sinks: readonly LogSink[]
  /** Shared with other logs, so one process holds one bound across them; takes the place of queueLimit. */
  budget?: LogBudget
  fallback?: (line: string) => void
}

export interface LoggerStats {
  dropped: number
  sinkFailures: number
}

export interface LoggerRoot {
  logger: Logger
  stats(): LoggerStats
  /** At the deadline it stops waiting; what is held stays queued. */
  flush(options?: { deadlineMs?: number }): Promise<void>
  /** At the deadline what is left is dropped and counted on the fallback. */
  close(options?: { deadlineMs?: number }): Promise<void>
}

const DEFAULT_MAX_OBJECT_KEYS = 100
const DEFAULT_MAX_EVENT_BYTES = 65_536

interface ErrorTrim { maxErrors: number; maxStackBytes: number; maxMessageBytes: number; maxCauseDepth: number }
// Tried in order until an oversized event fits: fewer aggregated errors, shorter stacks, then a bare error.
const ERROR_TRIMS: readonly ErrorTrim[] = [
  { maxErrors: 10, maxStackBytes: 4_096, maxMessageBytes: DEFAULT_MAX_STRING_BYTES, maxCauseDepth: 3 },
  { maxErrors: 3, maxStackBytes: 1_024, maxMessageBytes: 1_024, maxCauseDepth: 1 },
  { maxErrors: 0, maxStackBytes: 0, maxMessageBytes: 1_024, maxCauseDepth: 0 },
]
const SMALL_FIELD_BYTES = 256

export function createLogger(options: LoggerOptions): LoggerRoot {
  const config = readLoggerConfig(options)
  const threshold = levelRank(config.level)
  const warns = levelRank('warn') >= threshold
  const { maxEventBytes } = config
  const sanitize: SanitizeOptions = {
    maxStringBytes: config.maxStringBytes,
    maxDepth: 6,
    maxArrayItems: 50,
    maxObjectKeys: config.maxObjectKeys,
    allowKeys: config.allowKeys,
    omitKeys: config.omitKeys,
  }
  const fallback = options.fallback ?? writeFallbackLine
  // Marks this root's sinks while they run: a sink that logs through this root goes to the fallback,
  // while another root used inside a sink (an error reporter's HTTP client) still reaches its own sinks.
  const rootId = Symbol(options.component)
  const budget = options.budget ?? createLogBudget({ limit: config.queueLimit })
  const queues = options.sinks.map(sink => createSinkQueue(sink))
  const reportedErrors = new WeakSet<object>()
  const stats = { droppedAfterClose: 0, sinkFailures: 0 }
  let closed = false

  function emit(level: LogLevel, component: string, bindings: LogFields, message: string, fields: LogFields | undefined, lineOptions: LogPushOptions | undefined): void {
    if (levelRank(level) < threshold) return
    if (closed) {
      stats.droppedAfterClose += 1
      return
    }
    const event = buildEventSafely({ level, component, bindings, message, fields })
    if (sinkStorage.getStore() === rootId) return fallback(JSON.stringify(event))
    for (const queue of queues) queue.push(event, lineOptions)
  }

  // One queue per sink, so a sink that fails retries its own events alone. One event per write, as a sink takes them.
  function createSinkQueue(sink: LogSink): LogQueue<LogEvent> {
    const written = new WeakSet<LogEvent>()
    return createLogQueue<LogEvent>({
      destination: sink.name,
      budget,
      retryDelaysMs: config.retryDelaysMs,
      ...(config.writeDeadlineMs === undefined ? {} : { writeDeadlineMs: config.writeDeadlineMs }),
      maxBatch: 1,
      write: batch => writeToSink({ sink, written, batch }),
      summarize: drops => (warns ? dropSummary(sink.name, drops) : undefined),
      onDropping: notice => warnDropping(notice),
    })
  }

  // Diagnostics may degrade but never fail the caller (data.md): a field that cannot be read becomes a marker.
  function buildEventSafely(input: { level: LogLevel; component: string; bindings: LogFields; message: string; fields: LogFields | undefined }): LogEvent {
    try {
      return buildEvent(input)
    } catch (error) {
      return buildEvent({ ...input, message: typeof input.message === 'string' ? input.message : '[unloggable message]', bindings: {}, fields: { '[unloggable]': error instanceof Error ? error.name : typeof error } })
    }
  }

  // On the fallback, at once: the sink itself may be what cannot keep up.
  function warnDropping(notice: LogDropNotice): void {
    if (warns) fallback(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', component: 'logger', message: 'Log events dropped', fields: notice }))
  }

  // Built detached: the drop belongs to no request.
  function dropSummary(destination: string, drops: LogDrops): LogEvent {
    return runDetached(() => buildEvent({ level: 'warn', component: options.component, bindings: {}, message: 'log events dropped', fields: { destination, dropped: drops.count, firstAt: drops.firstAt, lastAt: drops.lastAt } }))
  }

  function buildEvent(input: { level: LogLevel; component: string; bindings: LogFields; message: string; fields: LogFields | undefined }): LogEvent {
    const { error, ...rest } = { ...input.bindings, ...input.fields }
    const fields = sanitizeFields(rest, sanitize)
    const correlationId = useScopeSafe()?.context.correlationId
    return fitEvent({
      timestamp: new Date().toISOString(),
      level: input.level,
      component: input.component,
      message: sanitizeString(String(input.message), sanitize),
      ...(correlationId ? { correlationId } : {}),
      ...(Object.keys(fields).length > 0 ? { fields: capFields(fields) } : {}),
      ...(error !== undefined ? { error: markRepeated(error) } : {}),
    })
  }

  function capFields(fields: Record<string, unknown>): Record<string, unknown> {
    const bytes = Buffer.byteLength(JSON.stringify(fields))
    return bytes <= maxEventBytes ? fields : { '[truncated]': `fields exceeded ${maxEventBytes} bytes (${bytes} bytes)` }
  }

  // The byte cap covers the whole event: error detail goes first, then fields larger than a short value.
  function fitEvent(event: LogEvent): LogEvent {
    if (eventBytes(event) <= maxEventBytes) return event
    const { error } = event
    for (const trim of ERROR_TRIMS) {
      if (!error) break
      const trimmed = { ...event, error: trimError(error, trim) }
      if (eventBytes(trimmed) <= maxEventBytes) return trimmed
    }
    const bare = error ? { ...event, error: trimError(error, ERROR_TRIMS.at(-1)!) } : event
    const note = { '[truncated]': `event exceeded ${maxEventBytes} bytes` }
    const withSmallFields = { ...bare, fields: { ...smallFields(bare.fields), ...note } }
    return eventBytes(withSmallFields) <= maxEventBytes ? withSmallFields : { ...bare, fields: note }
  }

  function markRepeated(error: unknown) {
    const normalized = normalizeError(error, sanitize)
    if (typeof error !== 'object' || error === null) return normalized
    if (reportedErrors.has(error)) return { ...normalized, repeated: true as const }
    reportedErrors.add(error)
    return normalized
  }

  // A retried batch skips the events this sink already took, so none is written twice.
  async function writeToSink(input: { sink: LogSink; written: WeakSet<LogEvent>; batch: readonly LogEvent[] }): Promise<void> {
    for (const event of input.batch) {
      if (input.written.has(event)) continue
      try {
        await sinkStorage.run(rootId, () => input.sink.write(event))
      } catch (error) {
        stats.sinkFailures += 1
        fallback(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', component: 'logger', message: `Log sink ${input.sink.name} failed`, error: normalizeError(error, sanitize), event: { level: event.level, message: event.message } }))
        throw error
      }
      input.written.add(event)
    }
  }

  async function drainAndFlushSinks(): Promise<void> {
    await Promise.all(queues.map(queue => queue.flush()))
    await Promise.all(options.sinks.map(sink => callSink(sink, 'flush')))
  }

  async function flush(flushOptions: { deadlineMs?: number } = {}): Promise<void> {
    if (flushOptions.deadlineMs === undefined) return drainAndFlushSinks()
    await settleWithin([drainAndFlushSinks()], flushOptions.deadlineMs)
  }

  // Closed first: anything logged while the sinks flush and close is dropped and counted, never written.
  async function close(closeOptions: { deadlineMs?: number } = {}): Promise<void> {
    closed = true
    const started = performance.now()
    const results = await Promise.all(queues.map(queue => queue.close(closeOptions)))
    const left = results.reduce((sum, result) => sum + result.left, 0)
    if (left > 0) fallback(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', component: 'logger', message: 'Log events left unwritten at close', fields: { left } }))
    const sinksClosed = closeSinks()
    if (closeOptions.deadlineMs === undefined) return sinksClosed
    await settleWithin([sinksClosed], closeOptions.deadlineMs - (performance.now() - started))
  }

  async function closeSinks(): Promise<void> {
    await Promise.all(options.sinks.map(sink => callSink(sink, 'flush')))
    await Promise.all(options.sinks.map(sink => callSink(sink, 'close')))
  }

  async function callSink(sink: LogSink, method: 'flush' | 'close'): Promise<void> {
    try { await sinkStorage.run(rootId, () => sink[method]?.()) } catch (error) {
      stats.sinkFailures += 1
      fallback(JSON.stringify({ level: 'error', component: 'logger', message: `Log sink ${sink.name} failed to ${method}`, error: normalizeError(error, sanitize) }))
    }
  }

  function createChild(component: string, bindings: LogFields): Logger {
    const method = (level: LogLevel) => (message: string, fields?: LogFields, lineOptions?: LogPushOptions) => emit(level, component, bindings, message, fields, lineOptions)
    const logger = Object.fromEntries(LOG_LEVELS.map(level => [level, method(level)])) as Record<LogLevel, Logger['info']>
    return {
      ...logger,
      log: logger.info,
      child: ({ component: childComponent, ...childBindings }) => createChild(childComponent ?? component, { ...bindings, ...childBindings }),
    }
  }

  return {
    logger: createChild(options.component, {}),
    stats: () => ({ dropped: stats.droppedAfterClose + queues.reduce((sum, queue) => sum + queue.stats().dropped, 0), sinkFailures: stats.sinkFailures }),
    flush,
    close,
  }
}

interface ResolvedLoggerConfig {
  level: LogLevel
  queueLimit: number
  retryDelaysMs: readonly number[]
  writeDeadlineMs: number | undefined
  maxStringBytes: number
  maxObjectKeys: number
  maxEventBytes: number
  allowKeys: ReadonlySet<string>
  omitKeys: ReadonlySet<string>
}

// Config values may come from the environment or JSON, where a type annotation proves nothing:
// a string omitKeys would silently omit single letters instead of the named keys.
function readLoggerConfig(config: LoggerConfig & { budget?: LogBudget }): ResolvedLoggerConfig {
  const level = config.level ?? 'info'
  if (!LOG_LEVELS.includes(level)) throw new TypeError(`Logger level must be one of ${LOG_LEVELS.join(', ')}; got ${String(level)}`)
  if (config.budget && config.queueLimit !== undefined) throw new TypeError('Logger takes a queueLimit or a budget, not both')
  return {
    level,
    queueLimit: readLimit('queueLimit', config.queueLimit, DEFAULT_LOG_LIMIT),
    retryDelaysMs: readTimerList('Logger retryDelaysMs', config.retryDelaysMs),
    writeDeadlineMs: readOptionalTimer('Logger writeDeadlineMs', config.writeDeadlineMs),
    maxStringBytes: readLimit('maxStringBytes', config.maxStringBytes, DEFAULT_MAX_STRING_BYTES),
    maxObjectKeys: readLimit('maxObjectKeys', config.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS),
    maxEventBytes: readLimit('maxEventBytes', config.maxEventBytes, DEFAULT_MAX_EVENT_BYTES),
    allowKeys: readKeys('allowKeys', config.allowKeys),
    omitKeys: readKeys('omitKeys', config.omitKeys),
  }
}

function readLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`Logger ${name} must be a positive integer; got ${String(value)}`)
  return value
}

function readKeys(name: string, keys: readonly string[] | undefined): ReadonlySet<string> {
  if (keys === undefined) return new Set()
  if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) throw new TypeError(`Logger ${name} must be an array of key names`)
  return new Set(keys)
}

function trimError(error: NormalizedError, trim: ErrorTrim, depth = 0): NormalizedError {
  const { stack, cause, errors, ...rest } = error
  const kept = errors?.slice(0, trim.maxErrors).map(item => trimError(item, trim, depth + 1)) ?? []
  const omitted = (errors?.length ?? 0) - kept.length
  return {
    ...rest,
    message: truncateText(error.message, trim.maxMessageBytes),
    ...(stack && trim.maxStackBytes > 0 ? { stack: truncateText(stack, trim.maxStackBytes) } : {}),
    ...(cause && depth < trim.maxCauseDepth ? { cause: trimError(cause, trim, depth + 1) } : {}),
    ...(errors ? { errors: omitted > 0 ? [...kept, { name: 'Omitted', message: `[${omitted} more errors]` }] : kept } : {}),
  }
}

function smallFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([, value]) => Buffer.byteLength(JSON.stringify(value) ?? '') <= SMALL_FIELD_BYTES))
}

function eventBytes(event: LogEvent): number {
  return Buffer.byteLength(JSON.stringify(event))
}

// Last resort when a sink fails: one synchronous stderr line, never routed back through a sink.
function writeFallbackLine(line: string): void {
  try { process.stderr.write(`${line}\n`) } catch { /* stderr itself is gone; nothing left to report to */ }
}
