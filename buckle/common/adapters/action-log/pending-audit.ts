import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { acquireFileLock, type FileLock } from '@5straps/runtime/sqlite'
import { z } from 'zod'
import type { ActionLogEntry } from '../../types/ports/action-log.js'
import { createJsonFileStore } from '../json-file-store.js'
import { entriesFrom, stringField } from './log-lines.js'

const pendingSchema = z.object({
  version: z.literal(1),
  pending: z.record(z.string(), z.object({
    offset: z.number().int().nonnegative(),
    processId: z.number().int().positive(),
    processInstanceId: z.string(),
    entry: z.object({
      auditId: z.string(), at: z.string(), requestId: z.string(), sessionId: z.string(), tool: z.string(),
      workspaceId: z.string().optional(), runId: z.string().optional(), stageId: z.string().optional(),
      chatId: z.string().optional(), projectId: z.string().optional(), actorId: z.string().optional(), agentId: z.string().optional(),
      actorTrust: z.literal('authenticated').optional(), claimedActorId: z.string().optional(), claimedActorTrust: z.literal('claimed').optional(),
      parentRequestId: z.string().optional(),
      args: z.json(), effects: z.array(z.string()), durationMs: z.number(),
    }),
  })),
})

export function createPendingAudit(input: {
  filePath: string
  processInstanceId: string
  isAlive?: (pid: number) => boolean
  /** How long a write waits for another process holding the pending state (the node's state lock wait). */
  lockDeadlineMs?: number
}) {
  const store = createJsonFileStore({ filePath: `${input.filePath}.pending.json`, schema: pendingSchema, fallback: { version: 1 as const, pending: {} }, lockDeadlineMs: input.lockDeadlineMs })
  return {
    /**
     * One update for a batch, each entry with the offset its line is at or after: each attempt is held until its result,
     * in the batch's order. Made again for the same entries, it leaves the same state.
     */
    async trackMany(placed: ReadonlyArray<{ entry: ActionLogEntry; offset: number }>): Promise<void> {
      const tracked = placed.flatMap(({ entry, offset }) => (entry.auditId && entry.event ? [{ auditId: entry.auditId, entry, offset }] : []))
      if (tracked.length === 0) return
      await store.update(state => {
        for (const { auditId, entry, offset } of tracked) {
          if (entry.event === 'attempt') {
            state.pending[auditId] = { offset, processId: process.pid, processInstanceId: input.processInstanceId, entry: { ...entry, auditId } }
          } else { delete state.pending[auditId] }
        }
      })
    },
    /** What a write needs of the pending store: it reads, and is written back, under its lock. */
    async probe(): Promise<void> {
      await store.update(() => undefined)
    },
    /** Writes, through `record`, an interrupted result for each attempt whose process stopped before its own. */
    async recover(record: (entry: ActionLogEntry) => Promise<void>): Promise<number> {
      const pending = store.read().pending
      if (!Object.keys(pending).length) return 0
      const lock = await tryRecoveryLock(`${input.filePath}.recovery.sqlite`)
      // Another process is recovering this log right now.
      if (!lock) return 0
      try {
        let recovered = 0
        for (const [auditId, item] of Object.entries(store.read().pending)) {
          const sameProcess = item.processId === process.pid && item.processInstanceId === input.processInstanceId
          const alive = (input.isAlive ?? processIsAlive)(item.processId)
          if (sameProcess || alive && item.processId !== process.pid) continue
          if (await hasTerminalRecord(input.filePath, auditId, item.offset)) {
            await store.update(state => { delete state.pending[auditId] })
            continue
          }
          await record({ ...item.entry, event: 'result', outcome: 'interrupted',
            at: new Date().toISOString(), detail: 'Owner process stopped before recording an outcome; effects are unknown',
          })
          recovered += 1
        }
        return recovered
      } finally {
        await lock.release()
      }
    },
  }
}

async function tryRecoveryLock(path: string): Promise<FileLock | null> {
  try {
    return await acquireFileLock({ path, wait: 'none' })
  } catch (error) {
    if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) return null
    throw error
  }
}

async function hasTerminalRecord(filePath: string, auditId: string, offset: number): Promise<boolean> {
  for await (const value of entriesFrom(filePath, offset)) {
    if (stringField(value, 'auditId') === auditId && stringField(value, 'event') === 'result') return true
  }
  return false
}

/** Whether a process is running, as the kernel answers a signal 0: one that cannot be signalled for want of permission is. */
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') }
}
