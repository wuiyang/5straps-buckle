import { randomUUID } from 'node:crypto'
import { setDescriptorMode } from '../file-modes.js'
import { StateBusyError } from '../json-file-store.js'
import { createPendingAudit } from './pending-audit.js'
import { closeSync, fsyncSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'pathe'
import { z } from 'zod'
import { logger } from '../../runtime/log.js'
import { maskHeldJson, masksHeld } from '../../services/secrets/mask.js'
import type { ActionLog, ActionLogEntry, AuditHealth } from '../../types/ports/action-log.js'
import type { ServiceFailure } from '../../types/service-failure.js'

const PROCESS_INSTANCE_ID = randomUUID()
const MAX_PAGE_BYTES = 1_048_576
const entrySchema = z.object({
  at: z.string(), requestId: z.string(), sessionId: z.string(), tool: z.string(),
  outcome: z.enum(['interrupted', 'started', 'ok', 'error', 'denied', 'approval_required']),
  durationMs: z.number(), effects: z.array(z.string()), args: z.json(), event: z.enum(['attempt', 'result']).optional(),
}).passthrough()

/** The code a transport tells an audit log that will not take a required write by. */
export const AUDIT_UNAVAILABLE = 'AUDIT_UNAVAILABLE'

/**
 * The audit log would not take a write: what must be audited does not run (HTTP 503) and readiness
 * reports it. The message names no path; the owner's log has the file and the cause.
 */
export class AuditUnavailableError extends Error implements ServiceFailure {
  readonly code = AUDIT_UNAVAILABLE
  readonly status = 503
  constructor(options?: ErrorOptions) {
    super('Buckle cannot write its audit log, so it refuses what it would have to record; the owner has to repair the audit storage', options)
  }
}

/**
 * `workspaceName`: the name of the log's own workspace, read at each write so a rename shows: every entry of that
 * workspace carries it beside its UUID (D85, Q15). An entry of another workspace, or one naming its own, is left as it is.
 */
export function createFileActionLog(filePath: string, options: { lockDeadlineMs?: number; health?: AuditHealth; workspaceId?: string; workspaceName?: () => string; serving?: () => boolean } = {}): ActionLog {
  const pending = createPendingAudit({ filePath, processInstanceId: PROCESS_INSTANCE_ID, record: entry => log.record(entry), lockDeadlineMs: options.lockDeadlineMs })
  const named = (entry: ActionLogEntry): ActionLogEntry => (options.workspaceName && entry.workspaceId === options.workspaceId && entry.workspaceName === undefined ? { ...entry, workspaceName: options.workspaceName() } : entry)
  const log: ActionLog = {
    recoverInterrupted: () => pending.recover(),
    async record(written) {
      // Masked by every secret value a call holds now, as a log line is (docs/secrets.md): a value never reaches the file.
      const entry = named(masksHeld() ? maskHeldJson(written) : written)
      try {
        const offset = appendSynced(filePath, (size, tail) => {
          const prefix = size > 0 && tail !== 10 ? '\n' : ''
          const data = Buffer.from(`${prefix}${JSON.stringify(entry)}\n`)
          if (data.length > 65_536) throw new Error('Audit entry exceeds the size limit')
          return data
        })
        await pending.track(entry, offset)
        options.health?.succeeded(filePath)
      } catch (error) {
        logger.error('Could not durably write the action log', { filePath, error })
        // Another process held the pending-audit state past the wait: temporary, so the caller is told
        // to retry, as for any busy state (review L3 of B15-B17), and the storage is not unhealthy.
        if (error instanceof StateBusyError) throw error
        // A disabled or retired workspace serves no call, so its log does not hold the node's readiness,
        // even when the owner reads it (review L12 of B23-B25).
        if (options.serving?.() !== false) options.health?.failed(filePath, { probe: () => probe(filePath, pending), workspaceId: options.workspaceId ?? 'node' })
        throw new AuditUnavailableError({ cause: error })
      }
    },
    read(limit) { return log.page({ limit: Math.min(limit, 200) }).entries.reverse() },
    page({ limit, before }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Audit limit must be between 1 and 200')
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('Invalid audit cursor')
      let descriptor: number
      try { descriptor = openSync(filePath, 'r') }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { entries: [], nextCursor: null }
        throw error
      }
      try {
        const end = Math.min(before ?? fstatSync(descriptor).size, fstatSync(descriptor).size)
        const start = Math.max(0, end - MAX_PAGE_BYTES)
        const bytes = Buffer.alloc(end - start)
        readSync(descriptor, bytes, 0, bytes.length, start)
        const entries: ActionLogEntry[] = []
        let cursor = bytes.length
        while (cursor > 0 && entries.length < limit) {
          const lineEnd = bytes[cursor - 1] === 10 ? cursor - 1 : cursor
          const previous = bytes.lastIndexOf(10, lineEnd - 1)
          if (previous < 0 && start > 0) { cursor = 0; break }
          const lineStart = previous + 1
          const line = bytes.subarray(lineStart, lineEnd).toString('utf8')
          cursor = lineStart
          if (!line) continue
          try {
            const value = entrySchema.parse(JSON.parse(line))
            // A line from before attempt and result entries (greenfield ruling) is not returned: its stored args predate redaction rules.
            if (value.event === undefined) continue
            // The schema checks the required fields; optional metadata passes through.
            entries.push(value as ActionLogEntry)
          } catch { logger.warn('Skipped an unreadable action log record', { filePath }) }
        }
        const next = start + cursor
        return { entries, nextCursor: next > 0 ? String(next) : null }
      } finally { closeSync(descriptor) }
    },
  }
  return log
}

/**
 * The one way the log is opened and written: created owner-only, read for its last byte, appended to
 * with what `data` makes of its size and last byte (nothing for a probe), then synced with its
 * directory. Returns the size before the append.
 */
function appendSynced(filePath: string, data: (size: number, tail: number | undefined) => Buffer): number {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const descriptor = openSync(filePath, 'a+', 0o600)
  try {
    setDescriptorMode(descriptor, 0o600)
    const size = fstatSync(descriptor).size
    const tail = Buffer.alloc(1)
    if (size > 0) readSync(descriptor, tail, 0, 1, size - 1)
    const bytes = data(size, size > 0 ? tail[0] : undefined)
    if (bytes.length > 0 && writeSync(descriptor, bytes) !== bytes.length) throw new Error('Incomplete audit write')
    fsyncSync(descriptor)
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(filePath), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    return size
  } finally { closeSync(descriptor) }
}

/**
 * Whether the log takes writes again, without writing an entry, testing what `record` needs (review
 * M4 of B20-B22): the file opens and syncs through record's own path (read access and the directory
 * sync included, review L13 of B23-B25), one byte beside it is written and synced (a full disk fails
 * here), and the pending store that tracks each attempt reads and writes under its lock.
 */
async function probe(filePath: string, pending: { probe(): Promise<void> }): Promise<void> {
  appendSynced(filePath, () => Buffer.alloc(0))
  const sidecar = `${filePath}.probe`
  const byte = openSync(sidecar, 'w', 0o600)
  try {
    if (writeSync(byte, Buffer.from('\n')) !== 1) throw new Error('Incomplete audit probe write')
    fsyncSync(byte)
  } finally {
    closeSync(byte)
    rmSync(sidecar, { force: true })
  }
  await pending.probe()
}
