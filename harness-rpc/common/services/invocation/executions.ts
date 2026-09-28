import { createHash } from 'node:crypto'
import type { InvokeRequest, InvokeResponse, JsonValue } from '@5straps/protocol'

/** How long a finished call answers a re-send: the time an ask it made stays answerable (approval-registry.ts). */
export const EXECUTION_TTL_MS = 10 * 60_000
/** How many finished calls a workspace keeps; the oldest goes first. */
export const EXECUTION_LIMIT = 256
/** A finished response kept whole up to this size; a larger one is answered with a stub that names its audit entry. */
export const EXECUTION_RESPONSE_BYTES = 256 * 1_024
/** What a re-send of a call that already ran is told when its own response cannot be given. */
export const REQUEST_ALREADY_EXECUTED = 'REQUEST_ALREADY_EXECUTED'
/** What a call is told when its requestId already names a different call (another tool or other arguments). */
export const REQUEST_ID_REUSED = 'REQUEST_ID_REUSED'

/**
 * One call as a re-send names it: the approval join's key (session, actor, requestId), with what it
 * asks for, so a requestId reused for a different call is refused instead of answered with another's
 * outcome.
 */
export interface ExecutionKey {
  sessionId: string
  actor?: string
  requestId: string
  /** The tool and its arguments, hashed (requestFingerprint). */
  fingerprint: string
}

/** The same call's fingerprint whatever order its arguments' keys arrive in. */
export function requestFingerprint(request: Pick<InvokeRequest, 'tool' | 'args'>): string {
  return createHash('sha256').update(JSON.stringify([request.tool, canonical(request.args)])).digest('hex')
}

/** The one execution of a key: started once the tool itself runs, settled with what the caller was answered. */
export interface Execution {
  /** The tool began to run; from here on the call counts as executed and its outcome is kept. */
  started(): void
  /** How the call ended. `callerLeft`: its caller's signal fired; once the tool ran, its effects are unknown. */
  settle(input: { response: InvokeResponse; auditId: string; callerLeft: boolean }): void
}

/** A call of the same key that runs now or ran lately: its outcome, or a refusal when it asked for something else. */
export type Earlier =
  | { kind: 'replay'; response: Promise<InvokeResponse> }
  | { kind: 'reused' }

export type ExecutionClaim = { kind: 'owner'; execution: Execution } | Earlier

export interface Executions {
  /** What a re-send gets without asking again, when the key ran lately or runs now. */
  earlier(key: ExecutionKey): Earlier | undefined
  /**
   * Called once a call is cleared to run: it becomes the key's one execution, or, when another call
   * of the key took that first, it waits for that one and answers with its outcome.
   */
  claim(key: ExecutionKey): ExecutionClaim
}

interface Kept<T> {
  fingerprint: string
  outcome: T
}

interface Finished extends Kept<InvokeResponse> {
  expiresAt: number
}

/**
 * Execution dedupe by requestId, per workspace (nitro/coordination.md, Completion and queue:
 * "Reconnection must not execute a request twice"; review M2 of B13-B14). A re-send while the call
 * runs gets its response when it settles; a finished call answers a re-send for EXECUTION_TTL_MS, its
 * response kept whole when small and as a REQUEST_ALREADY_EXECUTED stub otherwise. Only calls whose
 * tool actually ran are kept: a refusal, an approval still required or a superseded call asks again.
 * Kept in memory, so a restart forgets them; the action log keeps every run.
 */
export function createExecutions(options: { now?: () => number } = {}): Executions {
  const now = options.now ?? Date.now
  const running = new Map<string, Kept<Promise<InvokeResponse>>>()
  const finished = new Map<string, Finished>()

  function finishedFor(id: string): Finished | undefined {
    const entry = finished.get(id)
    if (entry && entry.expiresAt <= now()) finished.delete(id)
    return finished.get(id)
  }

  function keep(id: string, entry: Kept<InvokeResponse>): void {
    finished.delete(id)
    finished.set(id, { ...entry, expiresAt: now() + EXECUTION_TTL_MS })
    for (const oldest of finished.keys()) {
      if (finished.size <= EXECUTION_LIMIT) break
      finished.delete(oldest)
    }
  }

  function earlier(key: ExecutionKey): Earlier | undefined {
    const id = executionId(key)
    const done = finishedFor(id)
    const found = done ? { fingerprint: done.fingerprint, outcome: Promise.resolve(done.outcome) } : running.get(id)
    if (!found) return undefined
    return found.fingerprint === key.fingerprint ? { kind: 'replay', response: found.outcome } : { kind: 'reused' }
  }

  return {
    earlier,
    claim(key) {
      const found = earlier(key)
      if (found) return found
      const id = executionId(key)
      let started = false
      const settled = Promise.withResolvers<InvokeResponse>()
      running.set(id, { fingerprint: key.fingerprint, outcome: settled.promise })
      return {
        kind: 'owner',
        execution: {
          started: () => { started = true },
          settle({ response, auditId, callerLeft }) {
            running.delete(id)
            const answer = started && callerLeft ? alreadyExecuted({ requestId: response.requestId, auditId, reason: 'interrupted' }) : response
            settled.resolve(answer)
            if (started) keep(id, { fingerprint: key.fingerprint, outcome: fitsKept(answer) ? answer : alreadyExecuted({ requestId: response.requestId, auditId, reason: 'too_large' }) })
          },
        },
      }
    },
  }
}

function executionId(key: ExecutionKey): string {
  return JSON.stringify([key.sessionId, key.actor ?? null, key.requestId])
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name]!)]))
}

function fitsKept(response: InvokeResponse): boolean {
  return Buffer.byteLength(JSON.stringify(response)) <= EXECUTION_RESPONSE_BYTES
}

const ALREADY_EXECUTED_MESSAGE = {
  interrupted: 'This requestId already started running and its caller left before it finished, so its effects are unknown; send a new requestId to run it again',
  too_large: 'This requestId already ran; its result was too large to keep for a re-send; send a new requestId to run it again',
} as const

/** A re-send's answer when the original response cannot be given: never retryable under the same requestId. */
function alreadyExecuted(input: { requestId: string; auditId: string; reason: keyof typeof ALREADY_EXECUTED_MESSAGE }): InvokeResponse {
  return { requestId: input.requestId, outcome: 'error', error: { code: REQUEST_ALREADY_EXECUTED, message: ALREADY_EXECUTED_MESSAGE[input.reason], retryable: false, details: { auditId: input.auditId, reason: input.reason } } }
}
