import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ActionLogEntry } from '../../types/ports/action-log.js'
import { createJsonFileStore } from '../json-file-store.js'

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
      args: z.json(), effects: z.array(z.string()), durationMs: z.number(),
    }),
  })),
})

export function createPendingAudit(input: {
  filePath: string
  processInstanceId: string
  record: (entry: ActionLogEntry) => void
  isAlive?: (pid: number) => boolean
}) {
  const store = createJsonFileStore({ filePath: `${input.filePath}.pending.json`, schema: pendingSchema, fallback: { version: 1 as const, pending: {} } })
  return {
    track(entry: ActionLogEntry, offset: number) {
      if (!entry.auditId || !entry.event) return
      const auditId = entry.auditId
      store.update(state => {
        if (entry.event === 'attempt') {
          state.pending[auditId] = { offset, processId: process.pid, processInstanceId: input.processInstanceId, entry: { ...entry, auditId } }
        } else { delete state.pending[auditId] }
      })
    },
    async recover(): Promise<number> {
      const pending = store.read().pending
      if (!Object.keys(pending).length) return 0
      const lock = new DatabaseSync(`${input.filePath}.recovery.sqlite`, { timeout: 0 })
      let locked = false
      try {
        try { lock.exec('BEGIN IMMEDIATE'); locked = true }
        catch (error) {
          if (error instanceof Error && error.message.includes('locked')) return 0
          throw error
        }
        let recovered = 0
        for (const [auditId, item] of Object.entries(store.read().pending)) {
          const sameProcess = item.processId === process.pid && item.processInstanceId === input.processInstanceId
          const alive = (input.isAlive ?? processIsAlive)(item.processId)
          if (sameProcess || alive && item.processId !== process.pid) continue
          if (await hasTerminalRecord(input.filePath, auditId, item.offset)) {
            store.update(state => { delete state.pending[auditId] })
            continue
          }
          input.record({ ...item.entry, event: 'result', outcome: 'interrupted',
            at: new Date().toISOString(), detail: 'Owner process stopped before recording an outcome; effects are unknown',
          })
          recovered += 1
        }
        return recovered
      } finally {
        if (locked) lock.exec('COMMIT')
        lock.close()
      }
    },
  }
}

async function hasTerminalRecord(filePath: string, auditId: string, offset: number): Promise<boolean> {
  const stream = createReadStream(filePath, { start: offset })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        const value: unknown = JSON.parse(line)
        if (value && typeof value === 'object' && 'auditId' in value && value.auditId === auditId && 'event' in value && value.event === 'result') return true
      } catch { /* Torn records are retained in JSONL; only a complete result resolves an attempt. */ }
    }
    return false
  } finally { lines.close(); stream.destroy() }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') }
}
