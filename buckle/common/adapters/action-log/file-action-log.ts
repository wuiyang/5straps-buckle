import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { z } from 'zod'
import { logger } from '../../runtime/log.js'
import { maskHeldJson, masksHeld } from '../../services/secrets/mask.js'
import type { ActionLog, ActionLogEntry, AuditHealth } from '../../types/ports/action-log.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { StateBusyError } from '../json-file-store.js'
import { actionLogWriter, type ActionLogWriter } from './action-log-writer.js'
import { nameEntry, type LogFile, type WorkspaceNaming } from './writer-protocol.js'

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
 * `writer`: the process's writer worker unless a test hands in its own.
 */
export function createFileActionLog(filePath: string, options: { lockDeadlineMs?: number; health?: AuditHealth; workspaceId?: string; workspaceName?: () => string; serving?: () => boolean; writer?: ActionLogWriter } = {}): ActionLog {
  const file: LogFile = { path: filePath, ...(options.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: options.lockDeadlineMs }) }
  const writer = () => options.writer ?? actionLogWriter()
  const naming = (): WorkspaceNaming | undefined => (options.workspaceName ? { workspaceId: options.workspaceId, workspaceName: options.workspaceName() } : undefined)
  const log: ActionLog = {
    recoverInterrupted: () => writer().recover({ file, naming: naming() }),
    record: entry => log.recordMany([entry]),
    async recordMany(written) {
      if (written.length === 0) return
      // Masked by every secret value a call holds now, as a log line is (docs/user/how-to/secrets.md), before the entry
      // leaves this thread: a value never reaches the file.
      const named = naming()
      const entries = written.map(entry => nameEntry(masksHeld() ? maskHeldJson(entry) : entry, named))
      try {
        await writer().append({ file, entries })
        options.health?.succeeded(filePath)
      } catch (error) {
        logger.error('Could not durably write the action log', { filePath, error })
        // Another process held the pending-audit state past the wait: temporary, so the caller is told
        // to retry, as for any busy state (review L3 of B15-B17), and the storage is not unhealthy.
        if (error instanceof StateBusyError) throw error
        // A disabled or retired workspace serves no call, so its log does not hold the node's readiness,
        // even when the owner reads it (review L12 of B23-B25).
        if (options.serving?.() !== false) options.health?.failed(filePath, { probe: () => writer().probe(file), workspaceId: options.workspaceId ?? 'node' })
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
