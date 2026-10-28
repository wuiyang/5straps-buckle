import { randomUUID } from 'node:crypto'
import type { Checkpoint } from './records.js'

export const DEFAULT_HISTORY_KEEP_TURNS = 10
export const DEFAULT_HISTORY_TURN_IDLE_MS = 60_000

export function turnFor(input: { records: Checkpoint[]; sessionId: string; stageId: string | undefined; now: number; idleMs: number }): string {
  if (input.stageId !== undefined) {
    const same = input.records.find(record => record.sessionId === input.sessionId && record.turnStageId === input.stageId)
    return same?.turnId ?? `turn-${randomUUID()}`
  }
  const previous = input.records.findLast(record => record.sessionId === input.sessionId)
  return previous?.turnStageId === null && input.now - Date.parse(previous.createdAt) <= input.idleMs ? previous.turnId! : `turn-${randomUUID()}`
}

export function retainedTurns(input: { records: Checkpoint[]; keep: number }): Set<string> {
  const newest = [...new Set(input.records.toReversed().map(record => record.turnId ?? record.id))]
  return new Set(newest.slice(0, input.keep))
}
