import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileActionLog } from '../../common/adapters/action-log/file-action-log.js'
import { closeLogService, logService } from '../../common/adapters/action-log/log-service.js'
import { LOG_CLOSE_DEADLINE_MS } from '../../common/runtime/log-budget.js'
import type { ActionLog, ActionLogEntry } from '../../common/types/ports/action-log.js'

/**
 * Starts the process's action log writer with a write of its own. Its thread starts on a first write and loads through
 * tsx here, which can take longer than a test's waitFor gives that test's first call.
 */
export async function startActionLogWriter(): Promise<void> {
  const log = createFileActionLog(join(mkdtempSync(join(tmpdir(), 'buckle-writer-start-')), 'actions.jsonl'))
  await log.record({ event: 'result', at: new Date().toISOString(), requestId: 'start', sessionId: 'start', tool: 'start', outcome: 'ok', durationMs: 0, effects: [], args: {} })
}

/** Resolves once every entry the process's log service holds is written or dropped: read a log only after it. */
export function auditWritten(): Promise<void> {
  return logService().flush()
}

/** A log's last entries, read once the process's log service has written or dropped what it held. */
export async function auditEntries(log: Pick<ActionLog, 'read'>, limit: number): Promise<ActionLogEntry[]> {
  await auditWritten()
  return log.read(limit)
}

/**
 * What a test's cleanup awaits before it deletes a folder a log is in: the process's log service writes what it holds, or
 * gives up at the close deadline, so no write lands while the folder is deleted. A later append starts the service again.
 */
export async function settleAuditLogs(): Promise<void> {
  await closeLogService({ deadlineMs: LOG_CLOSE_DEADLINE_MS })
}
