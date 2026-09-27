import { once } from 'node:events'
import { chmodSync, mkdirSync } from 'node:fs'
import { appendFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Writable } from 'node:stream'
import { levelRank, type LogEvent, type LogLevel, type LogSink } from './types.js'

async function writeWithBackpressure(stream: Writable, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, 'drain')
}

export function createStderrJsonSink(options: { stream?: Writable } = {}): LogSink {
  const stream = options.stream ?? process.stderr
  return {
    name: 'stderr-json',
    write: event => writeWithBackpressure(stream, `${JSON.stringify(event)}\n`),
  }
}

// Explicit human rendering for an interactive CLI; services keep JSON.
export function createHumanSink(options: { stream?: Writable } = {}): LogSink {
  const stream = options.stream ?? process.stderr
  return {
    name: 'human',
    write: event => writeWithBackpressure(stream, `${renderHuman(event)}\n`),
  }
}

function renderHuman(event: LogEvent): string {
  const time = event.timestamp.slice(11, 19)
  const fields = Object.entries(event.fields ?? {}).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  const error = event.error ? [`error=${event.error.name}: ${event.error.message}`] : []
  const correlation = event.correlationId ? [`correlation=${event.correlationId}`] : []
  return [time, event.level.toUpperCase().padEnd(5), `[${event.component}]`, event.message, ...fields, ...error, ...correlation].join(' ')
}

export interface RotatingFileSinkOptions {
  path: string
  maxBytes: number
  maxFiles: number
}

// Opt-in file sink with bounded disk use: at most maxFiles rotated files of about maxBytes each.
export function createRotatingFileSink(options: RotatingFileSinkOptions): LogSink {
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
  let size: number | undefined

  async function currentSize(): Promise<number> {
    size ??= await stat(options.path).then(info => info.size, () => 0)
    return size
  }

  async function rotate(): Promise<void> {
    await rm(`${options.path}.${options.maxFiles}`, { force: true })
    for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
      await rename(`${options.path}.${index}`, `${options.path}.${index + 1}`).catch(ignoreMissing)
    }
    await rename(options.path, `${options.path}.1`).catch(ignoreMissing)
    size = 0
  }

  return {
    name: 'rotating-file',
    async write(event) {
      const line = `${JSON.stringify(event)}\n`
      const bytes = Buffer.byteLength(line)
      if ((await currentSize()) > 0 && (await currentSize()) + bytes > options.maxBytes) await rotate()
      await appendFile(options.path, line, { mode: 0o600 })
      if (size === 0) chmodSync(options.path, 0o600)
      size = (size ?? 0) + bytes
    },
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

export interface ErrorReporter {
  report(event: LogEvent): void | Promise<void>
  flush?(): void | Promise<void>
}

// Adapter for Sentry or another provider; skips errors already reported once through this logger.
export function createErrorReporterSink(options: { reporter: ErrorReporter; minLevel?: LogLevel }): LogSink {
  const minimum = levelRank(options.minLevel ?? 'error')
  return {
    name: 'error-reporter',
    write(event) {
      if (levelRank(event.level) < minimum || event.error?.repeated) return
      return options.reporter.report(event)
    },
    flush: () => options.reporter.flush?.(),
  }
}
