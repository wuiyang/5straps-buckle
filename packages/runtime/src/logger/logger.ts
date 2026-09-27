import { runDetached, sinkStorage } from '../internal/async-slots.js'
import { useScopeSafe } from '../scope/als.js'
import { normalizeError, sanitizeFields, sanitizeString, truncateText, type SanitizeOptions } from './sanitize.js'
import { levelRank, LOG_LEVELS, type LogEvent, type LogFields, type Logger, type LogLevel, type LogSink, type NormalizedError } from './types.js'

export interface LoggerOptions {
  component: string
  sinks: readonly LogSink[]
  level?: LogLevel
  queueLimit?: number
  maxStringBytes?: number
  maxObjectKeys?: number
  // Serialized size of a whole event; an oversized event loses error detail first, then large fields.
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

interface ErrorTrim { maxErrors: number; maxStackBytes: number; maxMessageBytes: number; maxCauseDepth: number }
// Tried in order until an oversized event fits: fewer aggregated errors, shorter stacks, then a bare error.
const ERROR_TRIMS: readonly ErrorTrim[] = [
  { maxErrors: 10, maxStackBytes: 4_096, maxMessageBytes: DEFAULT_MAX_STRING_BYTES, maxCauseDepth: 3 },
  { maxErrors: 3, maxStackBytes: 1_024, maxMessageBytes: 1_024, maxCauseDepth: 1 },
  { maxErrors: 0, maxStackBytes: 0, maxMessageBytes: 1_024, maxCauseDepth: 0 },
]
const SMALL_FIELD_BYTES = 256

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
  // Marks this root's sinks while they run: a sink that logs through this root goes to the fallback,
  // while another root used inside a sink (an error reporter's HTTP client) still reaches its own sinks.
  const rootId = Symbol(options.component)
  const queue: LogEvent[] = []
  const reportedErrors = new WeakSet<object>()
  const stats: LoggerStats = { dropped: 0, sinkFailures: 0 }
  let pumping: Promise<void> | undefined
  let dropping = false
  let droppedInEpisode = 0
  let closed = false

  function emit(level: LogLevel, component: string, bindings: LogFields, message: string, fields: LogFields | undefined): void {
    if (levelRank(level) < threshold) return
    if (closed) {
      stats.dropped += 1
      return
    }
    const event = buildEventSafely({ level, component, bindings, message, fields })
    if (sinkStorage.getStore() === rootId) return fallback(JSON.stringify(event))
    if (queue.length >= queueLimit) return drop(component)
    enqueue(event)
  }

  // Diagnostics may degrade but never fail the caller (data.md): a field that cannot be read becomes a marker.
  function buildEventSafely(input: { level: LogLevel; component: string; bindings: LogFields; message: string; fields: LogFields | undefined }): LogEvent {
    try {
      return buildEvent(input)
    } catch (error) {
      return buildEvent({ ...input, message: typeof input.message === 'string' ? input.message : '[unloggable message]', bindings: {}, fields: { '[unloggable]': error instanceof Error ? error.name : typeof error } })
    }
  }

  function enqueue(event: LogEvent): void {
    queue.push(event)
    pumping ??= pump().finally(() => { pumping = undefined })
  }

  // One warning per episode, allowed past the limit, so a full queue is visible in the sinks themselves.
  // Built detached: the drop belongs to no request.
  function drop(component: string): void {
    stats.dropped += 1
    droppedInEpisode += 1
    if (dropping) return
    dropping = true
    if (levelRank('warn') >= threshold) enqueue(runDetached(() => buildEvent({ level: 'warn', component, bindings: {}, message: 'log events dropped: queue full', fields: { queueLimit } })))
  }

  function dropSummary(): LogEvent {
    const dropped = droppedInEpisode
    droppedInEpisode = 0
    return runDetached(() => buildEvent({ level: 'warn', component: options.component, bindings: {}, message: 'log events dropped: queue drained', fields: { queueLimit, dropped } }))
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

  async function pump(): Promise<void> {
    await Promise.resolve()
    while (queue.length > 0) {
      const event = queue.shift()!
      await Promise.all(options.sinks.map(sink => writeToSink(sink, event)))
      // The episode ends once the queue has drained: report how many events were lost.
      if (queue.length === 0 && droppedInEpisode > 0 && levelRank('warn') >= threshold) queue.push(dropSummary())
    }
    droppedInEpisode = 0
    dropping = false
  }

  async function writeToSink(sink: LogSink, event: LogEvent): Promise<void> {
    try {
      await sinkStorage.run(rootId, () => sink.write(event))
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
    try { await sinkStorage.run(rootId, () => sink[method]?.()) } catch (error) {
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
