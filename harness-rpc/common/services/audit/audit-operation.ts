import { randomUUID } from 'node:crypto'
import type { ActionLog } from '../../types/ports/action-log.js'

export async function auditOperation<T>(input: {
  actions: ActionLog
  workspaceId: string
  tool: string
  sessionId: string
  operation: () => T | Promise<T>
  isSuccessful?: (result: T) => boolean
  /** A line for the result entry, from what the operation returned: what a widened approval covers. */
  describe?: (result: T) => string | undefined
}): Promise<T> {
  const auditId = randomUUID()
  const start = performance.now()
  const entry = { auditId, workspaceId: input.workspaceId, tool: input.tool, sessionId: input.sessionId,
    requestId: auditId, at: new Date().toISOString(), effects: [], args: {}, durationMs: 0,
  }
  input.actions.record({ ...entry, event: 'attempt', outcome: 'started' })
  let value: T
  try { value = await input.operation() }
  catch (error) {
    input.actions.record({ ...entry, event: 'result', outcome: 'error', durationMs: Math.round(performance.now() - start) })
    throw error
  }
  const detail = input.describe?.(value)
  input.actions.record({ ...entry, event: 'result', outcome: input.isSuccessful && !input.isSuccessful(value) ? 'error' : 'ok', durationMs: Math.round(performance.now() - start), ...(detail ? { detail } : {}) })
  return value
}
