import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { LogDrops } from '@5straps/runtime'
import { z } from 'zod'
import { LOG_DROPPED_TOOL } from '../../domain/record-tools.js'
import { OWNER_RECORDS_WAIT } from '../../runtime/log-budget.js'
import { logger } from '../../runtime/log.js'
import { maskHeldJson, masksHeld } from '../../services/secrets/mask.js'
import type { ActionLog, ActionLogEntry, AuditHealth } from '../../types/ports/action-log.js'
import type { LogDestination, LogService } from '../../types/ports/log-service.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { StateBusyError } from '../json-file-store.js'
import { actionLogWriter, type ActionLogWriter } from './action-log-writer.js'
import { logService } from './log-service.js'
import { entryLine, MAX_ENTRY_BYTES, nameEntry, withEntryId, type LogFile, type WorkspaceNaming } from './writer-protocol.js'

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
 * `workspaceName`: the name of the log's own workspace, read as each entry is handed in, so a rename shows: every entry
 * of that workspace carries it beside its UUID. An entry of another workspace, or one naming its own, is left as it is.
 * `purgeable`: the log's folder holds its workspace's records, which a purge deletes, so a queued entry is not written
 * once the folder is gone, and none makes it again.
 * `writer` and `service`: the process's writer worker and log service unless a test hands in its own.
 */
export function createFileActionLog(filePath: string, options: { lockDeadlineMs?: number; health?: AuditHealth; workspaceId?: string; workspaceName?: () => string; serving?: () => boolean; purgeable?: boolean; writer?: ActionLogWriter; service?: LogService } = {}): ActionLog {
  const file: LogFile = { path: filePath, ...(options.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: options.lockDeadlineMs }) }
  const writer = () => options.writer ?? actionLogWriter()
  const service = () => options.service ?? logService()
  const naming = (): WorkspaceNaming | undefined => (options.workspaceName ? { workspaceId: options.workspaceId, workspaceName: options.workspaceName() } : undefined)
  // Masked by every secret value a call holds now, as a log line is (docs/user/how-to/secrets.md), and named, before the
  // entry leaves this thread or waits in a queue: a value never reaches the file.
  const prepared = (entry: ActionLogEntry): ActionLogEntry => nameEntry(masksHeld() ? maskHeldJson(entry) : entry, naming())
  async function write(entries: ActionLogEntry[], mode: { queued: boolean }): Promise<void> {
    try {
      await writer().append({ file, entries, ...(mode.queued && options.purgeable ? { existingFolder: true as const } : {}) })
      options.health?.succeeded(filePath)
    } catch (error) {
      logger.error('Could not durably write the action log', { filePath, error })
      // Another process held the pending-audit state past the wait: temporary, so the caller is told
      // to retry, as for any busy state, and the storage is not unhealthy.
      if (error instanceof StateBusyError) throw error
      // A disabled or retired workspace serves no call, so its log does not hold the node's readiness,
      // even when the owner reads it.
      if (options.serving?.() !== false) options.health?.failed(filePath, { probe: () => writer().probe(file), workspaceId: options.workspaceId ?? 'node' })
      throw new AuditUnavailableError({ cause: error })
    }
  }
  const destination: LogDestination = {
    name: filePath,
    write: entries => write([...entries], { queued: true }),
    dropped: drops => prepared(droppedEntry({ drops, workspaceId: options.workspaceId })),
  }
  const log: ActionLog = {
    recoverInterrupted: () => writer().recover({ file, naming: naming() }),
    record: entry => log.recordMany([entry]),
    // Its id now, kept across every attempt the service makes at writing it, so a retry never writes it twice.
    append: (entry, appendOptions) => service().append(destination, withinSizeLimit(withEntryId(prepared(entry))), appendOptions),
    async ownerAttempt(entry) {
      if (OWNER_RECORDS_WAIT) return log.record(entry)
      log.append(entry)
    },
    async recordMany(entries) {
      if (entries.length === 0) return
      await write(entries.map(prepared), { queued: false })
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

/** The entry that tells a log how many of its entries were dropped unwritten, and over what time. */
function droppedEntry(input: { drops: LogDrops; workspaceId: string | undefined }): ActionLogEntry {
  const auditId = randomUUID()
  return withEntryId({
    auditId, event: 'result', ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }), at: new Date().toISOString(), requestId: auditId,
    sessionId: 'buckle', tool: LOG_DROPPED_TOOL, outcome: 'error', durationMs: 0, effects: [],
    args: { dropped: input.drops.count, firstAt: input.drops.firstAt, lastAt: input.drops.lastAt },
    detail: `${input.drops.count} entries of this log were dropped unwritten`,
  })
}

/**
 * An entry whose line would pass the size limit keeps what names it and its outcome, and says what it left out, so the
 * worker does not refuse it and the batch it rides in.
 */
function withinSizeLimit(entry: ActionLogEntry): ActionLogEntry {
  const bytes = Buffer.byteLength(entryLine(entry))
  if (bytes <= MAX_ENTRY_BYTES) return entry
  const { args: _args, effects: _effects, detail: _detail, judge: _judge, asked: _asked, approvedBy: _approvedBy, decidedBy: _decidedBy, grantUses: _grantUses, ...named } = entry
  return { ...named, args: {}, effects: [], detail: `This entry took ${bytes} bytes, past the size limit of ${MAX_ENTRY_BYTES}: its arguments, effects, rules, judge, and detail were left out` }
}
