import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSlot } from '../internal/async-slots.js'
import { useScopeSafe } from '../scope/als.js'
import { normalizeError, sanitizeFields, sanitizeString, type SanitizeOptions } from './sanitize.js'
import { levelRank, LOG_LEVELS, type LogEvent, type LogFields, type Logger, type LogLevel, type LogSink } from './types.js'

export interface LoggerOptions {
  component: string
  sinks: readonly LogSink[]
  level?: LogLevel
  queueLimit?: number
  maxStringBytes?: number
  maxObjectKeys?: number
  // Serialized size above which an event's fields are replaced by a truncation note.
  maxEventBytes?: number
  /** Keys exempt from secret and content redaction; opt-in per deployment. */
  allowKeys?: readonly string[]
  /** Extra keys whose values are omitted with their size, like file contents. */
  omitKeys?: readonly string[]
  fallback?: (line: string) => void
}

export interface LoggerStats {
  dropped: number
  sinkFailures: number
}

export interface LoggerRoot {
  logger: Logger
  stats(): LoggerStats
  flush(): Promise<void>
  close(): Promise<void>
}

const DEFAULT_QUEUE_LIMIT = 1_000
const DEFAULT_MAX_STRING_BYTES = 8_192
const DEFAULT_MAX_OBJECT_KEYS = 100
const DEFAULT_MAX_EVENT_BYTES = 65_536
// Set while any sink runs, across its awaits, so a sink that logs cannot feed itself.
const insideSink = globalSlot('logger-sink', () => new AsyncLocalStorage<true>())

export function createLogger(options: LoggerOptions): LoggerRoot {
  const threshold = levelRank(options.level ?? 'info')
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
  const sanitize: SanitizeOptions = {
    maxStringBytes: options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
    maxDepth: 6,
    maxArrayItems: 50,
    maxObjectKeys: options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
    allowKeys: new Set(options.allowKeys ?? []),
    omitKeys: new Set(options.omitKeys ?? []),
  }
  const fallback = options.fallback ?? writeFallbackLine
  const queue: LogEvent[] = []
  const reportedErrors = new WeakSet<object>()
  const stats: LoggerStats = { dropped: 0, sinkFailures: 0 }
  let pumping: Promise<void> | undefined
  let dropping = false
  let closed = false

  function emit(level: LogLevel, component: string, bindings: LogFields, message: string, fields: LogFields | undefined): void {
    if (levelRank(level) < threshold) return
    if (closed) {
      stats.dropped += 1
      return
    }
    const event = buildEvent({ level, component, bindings, message, fields })
    // A sink that logs while writing must not feed itself; that line goes to the fallback only.
    if (insideSink.getStore()) return fallback(JSON.stringify(event))
    if (queue.length >= queueLimit) return drop(component)
    enqueue(event)
  }

  function enqueue(event: LogEvent): void {
    queue.push(event)
    pumping ??= pump().finally(() => { pumping = undefined })
  }

  // One warning per episode, allowed past the limit, so a full queue is visible in the sinks themselves.
  function drop(component: string): void {
    stats.dropped += 1
    if (dropping) return
    dropping = true
    enqueue(buildEvent({ level: 'warn', component, bindings: {}, message: 'log events dropped: queue full', fields: { queueLimit } }))
  }

  function buildEvent(input: { level: LogLevel; component: string; bindings: LogFields; message: string; fields: LogFields | undefined }): LogEvent {
    const { error, ...rest } = { ...input.bindings, ...input.fields }
    const fields = sanitizeFields(rest, sanitize)
    const correlationId = useScopeSafe()?.context.correlationId
    return {
      timestamp: new Date().toISOString(),
      level: input.level,
      component: input.component,
      message: sanitizeString(input.message, sanitize),
      ...(correlationId ? { correlationId } : {}),
      ...(Object.keys(fields).length > 0 ? { fields: capFields(fields) } : {}),
      ...(error !== undefined ? { error: markRepeated(error) } : {}),
    }
  }

  function capFields(fields: Record<string, unknown>): Record<string, unknown> {
    const bytes = Buffer.byteLength(JSON.stringify(fields))
    return bytes <= maxEventBytes ? fields : { '[truncated]': `fields exceeded ${maxEventBytes} bytes (${bytes} bytes)` }
  }

  function markRepeated(error: unknown) {
    const normalized = normalizeError(error, sanitize)
    if (typeof error !== 'object' || error === null) return normalized
    if (reportedErrors.has(error)) return { ...normalized, repeated: true as const }
    reportedErrors.add(error)
    return normalized
  }

  async function pump(): Promise<void> {
    await Promise.resolve()
    while (queue.length > 0) {
      const event = queue.shift()!
      await Promise.all(options.sinks.map(sink => writeToSink(sink, event)))
    }
    dropping = false
  }

  async function writeToSink(sink: LogSink, event: LogEvent): Promise<void> {
    try {
      await insideSink.run(true, () => sink.write(event))
    } catch (error) {
      stats.sinkFailures += 1
      fallback(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', component: 'logger', message: `Log sink ${sink.name} failed`, error: normalizeError(error, sanitize), dropped: { level: event.level, message: event.message } }))
    }
  }

  async function flush(): Promise<void> {
    while (pumping) await pumping
    await Promise.all(options.sinks.map(sink => callSink(sink, 'flush')))
  }

  async function callSink(sink: LogSink, method: 'flush' | 'close'): Promise<void> {
    try { await sink[method]?.() } catch (error) {
      stats.sinkFailures += 1
      fallback(JSON.stringify({ level: 'error', component: 'logger', message: `Log sink ${sink.name} failed to ${method}`, error: normalizeError(error, sanitize) }))
    }
  }

  function createChild(component: string, bindings: LogFields): Logger {
    const method = (level: LogLevel) => (message: string, fields?: LogFields) => emit(level, component, bindings, message, fields)
    const logger = Object.fromEntries(LOG_LEVELS.map(level => [level, method(level)])) as Record<LogLevel, Logger['info']>
    return {
      ...logger,
      log: logger.info,
      child: ({ component: childComponent, ...childBindings }) => createChild(childComponent ?? component, { ...bindings, ...childBindings }),
    }
  }

  return {
    logger: createChild(options.component, {}),
    stats: () => ({ ...stats }),
    flush,
    // Closed first: anything logged while the sinks flush and close is dropped and counted, never written.
    async close() {
      closed = true
      await flush()
      await Promise.all(options.sinks.map(sink => callSink(sink, 'close')))
    },
  }
}

// Last resort when a sink fails: one synchronous stderr line, never routed back through a sink.
function writeFallbackLine(line: string): void {
  try { process.stderr.write(`${line}\n`) } catch { /* stderr itself is gone; nothing left to report to */ }
}
