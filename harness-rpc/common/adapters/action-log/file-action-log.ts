import { randomUUID } from 'node:crypto'
import { StateBusyError } from '../json-file-store.js'
import { createPendingAudit } from './pending-audit.js'
import { closeSync, fsyncSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { logger } from '../../runtime/log.js'
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

export function createFileActionLog(filePath: string, options: { lockDeadlineMs?: number; health?: AuditHealth } = {}): ActionLog {
  const pending = createPendingAudit({ filePath, processInstanceId: PROCESS_INSTANCE_ID, record: entry => log.record(entry), lockDeadlineMs: options.lockDeadlineMs })
  const log: ActionLog = {
    recoverInterrupted: () => pending.recover(),
    async record(entry) {
      try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
        let offset = 0
        const descriptor = openSync(filePath, 'a+', 0o600)
        try {
          fchmodSync(descriptor, 0o600)
          const size = fstatSync(descriptor).size
          offset = size
          const tail = Buffer.alloc(1)
          if (size > 0) readSync(descriptor, tail, 0, 1, size - 1)
          const prefix = size > 0 && tail[0] !== 10 ? '\n' : ''
          const data = Buffer.from(`${prefix}${JSON.stringify(entry)}\n`)
          if (data.length > 65_536) throw new Error('Audit entry exceeds the size limit')
          if (writeSync(descriptor, data) !== data.length) throw new Error('Incomplete audit write')
          fsyncSync(descriptor)
          if (process.platform !== 'win32') {
            const directory = openSync(dirname(filePath), 'r')
            try { fsyncSync(directory) } finally { closeSync(directory) }
          }
        } finally { closeSync(descriptor) }
        await pending.track(entry, offset)
        options.health?.succeeded()
      } catch (error) {
        logger.error('Could not durably write the action log', { filePath, error })
        // Another process held the pending-audit state past the wait: temporary, so the caller is told
        // to retry, as for any busy state (review L3 of B15-B17), and the storage is not unhealthy.
        if (error instanceof StateBusyError) throw error
        options.health?.failed()
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
