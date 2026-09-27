import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { toError } from '../errors.js'
import { isSqliteBusy } from './busy.js'

interface BeginImmediateOptions<T> {
  deadlineMs: number
  pollMs: number
  signal?: AbortSignal
  // Its return value is thrown when the signal aborts.
  onAbort?: (reason: unknown) => Error
  // Runs synchronously right after BEGIN succeeds, before any other code can touch the connection.
  onBegin: () => T
}

// Polls BEGIN IMMEDIATE with busy_timeout 0 so waiting for another writer yields the event loop
// instead of sleeping inside SQLite. Throws the last busy error once the deadline passes.
// Only the begin is asynchronous: statements inside the transaction still block for up to busy_timeout.
export async function beginImmediateWithinDeadline<T>(connection: DatabaseSync, options: BeginImmediateOptions<T>): Promise<T> {
  // Monotonic, so a wall-clock step cannot stretch or cut the wait.
  const deadline = performance.now() + options.deadlineMs
  const restoreBusyTimeoutMs = readBusyTimeout(connection)
  const aborted = (reason: unknown) => options.onAbort?.(reason) ?? toError(reason)
  while (true) {
    if (options.signal?.aborted) throw aborted(options.signal.reason)
    try {
      tryBeginImmediate(connection, restoreBusyTimeoutMs)
    } catch (error) {
      if (!isSqliteBusy(error) || performance.now() >= deadline) throw error
      await delay(options.pollMs, undefined, options.signal ? { signal: options.signal } : undefined).catch(() => {
        throw aborted(options.signal?.reason)
      })
      continue
    }
    return options.onBegin()
  }
}

export function readBusyTimeout(connection: DatabaseSync): number {
  const row = connection.prepare('PRAGMA busy_timeout').get()
  return row ? Number(Object.values(row)[0]) : 0
}

// Synchronous, so no other code on this event loop ever observes the temporary busy_timeout of 0.
function tryBeginImmediate(connection: DatabaseSync, busyTimeoutMs: number): void {
  if (busyTimeoutMs === 0) return connection.exec('BEGIN IMMEDIATE')
  connection.exec('PRAGMA busy_timeout=0')
  try {
    connection.exec('BEGIN IMMEDIATE')
  } finally {
    connection.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`)
  }
}
