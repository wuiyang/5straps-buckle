import { randomUUID } from 'node:crypto'
import { createPendingAudit } from './pending-audit.js'
import { closeSync, fsyncSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { logger } from '../../runtime/log.js'
import type { ActionLog, ActionLogEntry } from '../../types/ports/action-log.js'

const PROCESS_INSTANCE_ID = randomUUID()
const MAX_PAGE_BYTES = 1_048_576
const entrySchema = z.object({
  at: z.string(), requestId: z.string(), sessionId: z.string(), tool: z.string(),
  outcome: z.enum(['interrupted', 'started', 'ok', 'error', 'denied', 'approval_required']),
  durationMs: z.number(), effects: z.array(z.string()), args: z.json(),
}).passthrough()

export function createFileActionLog(filePath: string): ActionLog {
  const pending = createPendingAudit({ filePath, processInstanceId: PROCESS_INSTANCE_ID, record: entry => log.record(entry) })
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
      } catch (error) {
        logger.error('Could not durably write the action log', { filePath })
        throw new Error('Audit storage unavailable; tool execution cannot continue', { cause: error })
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
