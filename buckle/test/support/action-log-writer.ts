import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileActionLog } from '../../common/adapters/action-log/file-action-log.js'

/**
 * Starts the process's action log writer with a write of its own. Its thread starts on a first write and loads through
 * tsx here, which can take longer than a test's waitFor gives that test's first call.
 */
export async function startActionLogWriter(): Promise<void> {
  const log = createFileActionLog(join(mkdtempSync(join(tmpdir(), 'buckle-writer-start-')), 'actions.jsonl'))
  await log.record({ event: 'result', at: new Date().toISOString(), requestId: 'start', sessionId: 'start', tool: 'start', outcome: 'ok', durationMs: 0, effects: [], args: {} })
}
