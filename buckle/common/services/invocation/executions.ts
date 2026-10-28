import { createHash } from 'node:crypto'
import type { InvokeRequest, InvokeResponse, JsonValue } from '@5straps/protocol'

/** How long a finished call answers a re-send: the time an ask it made stays answerable (approval-registry.ts). */
export const EXECUTION_TTL_MS = 10 * 60_000
/** How many finished calls a workspace keeps; the oldest goes first. */
export const EXECUTION_LIMIT = 256
/** A finished response kept whole up to this size; a larger one is answered with a stub that names its audit entry. */
export const EXECUTION_RESPONSE_BYTES = 256 * 1_024
/** The kept responses' bytes per workspace, and across the node's workspaces; the oldest go first (review L3 of B18-B19). */
export const WORKSPACE_EXECUTION_BYTES = 16 * 1_024 * 1_024
export const NODE_EXECUTION_BYTES = 64 * 1_024 * 1_024
/** What a re-send of a call that already ran is told when its own response cannot be given. */
export const REQUEST_ALREADY_EXECUTED = 'REQUEST_ALREADY_EXECUTED'
/**
 * The script calls' kept answers a workspace holds, each a stub without its body, in a bound of their own beside the
 * other calls' (review of the code-mode slice, finding invoker-audit executions.ts:7).
 */
export const SCRIPT_STUB_LIMIT = 4_096
/**
 * The stubs a workspace keeps for finished calls whose answers the store dropped (the entry limit or a byte budget), in
 * a bound of their own, for the time the answer would have been kept: a re-send of such a call is told it ran, and
 * never runs it again (review of the MCP asks slice, finding M2). Past the bound the oldest stub goes first.
 */
export const EVICTED_STUB_LIMIT = 4_096
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

/**
 * The key a requestId joins and dedupes under: a hash of the whole id, so two ids that share a
 * prefix never meet, and a long id stores as 64 characters (review L2 of B18-B19).
 */
export function requestIdKey(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex')
}

/** The same call's fingerprint whatever order its arguments' keys arrive in. */
export function requestFingerprint(request: Pick<InvokeRequest, 'tool' | 'args'>): string {
  return createHash('sha256').update(JSON.stringify([request.tool, canonical(request.args)])).digest('hex')
}

/**
 * The key a script's calls are named under, `code:<key>:<call number>` (owner decision D82, point 4), and its replay
 * journal is filed under: the session, the actor, and the outer call's tool and what names its script, hashed.
 */
export function nestedCallKey(key: Pick<ExecutionKey, 'sessionId' | 'actor' | 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify([key.sessionId, key.actor ?? null, key.fingerprint])).digest('hex')
}

/** The one execution of a key: started once the tool itself runs, settled with what the caller was answered. */
export interface Execution {
  /** The tool began to run; from here on the call counts as executed and its outcome is kept. */
  started(): void
  /**
   * How the call ended. `callerLeft`: its caller's signal fired; once the tool ran, its effects are unknown. `script`:
   * a call a script made, kept as a stub, since the script's journal replays its result (owner decision D82).
   */
  settle(input: { response: InvokeResponse; auditId: string; callerLeft: boolean; script?: boolean }): void
}

/**
 * A call of the same key that runs now or ran lately: its outcome, or a refusal when it asked for something else.
 * `at`: when a finished call ended, on the store's clock; absent while it still runs.
 */
export type Earlier =
  | { kind: 'replay'; response: Promise<InvokeResponse>; at?: number }
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
  /**
   * Drops a finished call's kept outcome, so a re-send runs it again: a script's calls once the script finished
   * (owner decision D82), whose next run of the same script is a new run.
   */
  forget(key: Pick<ExecutionKey, 'sessionId' | 'actor' | 'requestId'>): void
}

interface Kept<T> {
  fingerprint: string
  outcome: T
}

interface Finished extends Kept<InvokeResponse> {
  expiresAt: number
  at: number
  slot: BudgetSlot
  auditId: string
}

/** An answer kept without its body: it only says the call ran. */
type Stub = Kept<InvokeResponse> & { expiresAt: number; at: number }

/** One kept response as the node's budget counts it; `evict` drops it from its workspace's store. */
export interface BudgetSlot {
  readonly bytes: number
  evict(): void
}

/** The node's byte budget for kept responses, shared by every workspace's store; the node-wide oldest goes first. */
export interface ExecutionBudget {
  add(slot: BudgetSlot): void
  remove(slot: BudgetSlot): void
}

export function createExecutionBudget(limitBytes = NODE_EXECUTION_BYTES): ExecutionBudget {
  // Insertion order is age: the first slot is the node's oldest kept response.
  const slots = new Set<BudgetSlot>()
  let bytes = 0
  const budget: ExecutionBudget = {
    add(slot) {
      slots.add(slot)
      bytes += slot.bytes
      for (const oldest of slots) {
        if (bytes <= limitBytes) break
        oldest.evict()
      }
    },
    remove(slot) {
      if (slots.delete(slot)) bytes -= slot.bytes
    },
  }
  return budget
}

/**
 * Execution dedupe by requestId, per workspace (nitro/coordination.md, Completion and queue:
 * "Reconnection must not execute a request twice"; review M2 of B13-B14). A re-send while the call
 * runs gets its response when it settles; a finished call answers a re-send for EXECUTION_TTL_MS, its
 * response kept whole when small and as a REQUEST_ALREADY_EXECUTED stub otherwise, within a byte
 * budget per workspace and one per node, and as a stub of its own once either drops it (review of the MCP asks slice,
 * finding M2). Only calls whose tool actually ran are kept: a refusal, an approval still required or a superseded
 * call asks again, and so does an error the tool called retryable, so an idempotent retry under the same requestId
 * runs again (review L4 of B18-B19). Kept in memory, so a restart forgets them; the action log keeps every run.
 */
export function createExecutions(options: { now?: () => number; budget?: ExecutionBudget; workspaceBytes?: number } = {}): Executions {
  // Read at each call, so a clock stood in for in a test reaches the store (review of the code-mode slice, finding tests 181).
  const now = options.now ?? (() => Date.now())
  const budget = options.budget ?? createExecutionBudget()
  const workspaceBytes = options.workspaceBytes ?? WORKSPACE_EXECUTION_BYTES
  const running = new Map<string, Kept<Promise<InvokeResponse>>>()
  const finished = new Map<string, Finished>()
  // A script's calls that ran: stubs that only say so, oldest first, so one script's 256 calls can neither evict the
  // workspace's other re-send answers nor be evicted by them (review of the code-mode slice, finding invoker-audit
  // executions.ts:7).
  const stubs = new Map<string, Stub>()
  // The answers the store dropped, oldest first, each for the time it would have been kept.
  const dropped = new Map<string, Stub>()
  let bytes = 0

  function forget(id: string): void {
    stubs.delete(id)
    dropped.delete(id)
    const entry = finished.get(id)
    if (!entry) return
    finished.delete(id)
    bytes -= entry.slot.bytes
    budget.remove(entry.slot)
  }

  /** The store drops a kept answer for room: what stays says the call ran, until the answer's time is up. */
  function drop(id: string): void {
    const entry = finished.get(id)
    forget(id)
    if (!entry) return
    dropped.set(id, { fingerprint: entry.fingerprint, outcome: alreadyExecuted({ requestId: entry.outcome.requestId, auditId: entry.auditId, reason: 'evicted' }), expiresAt: entry.expiresAt, at: entry.at })
    trim(dropped, EVICTED_STUB_LIMIT)
  }

  function finishedFor(id: string): (Kept<InvokeResponse> & { at: number }) | undefined {
    const entry = finished.get(id) ?? stubs.get(id) ?? dropped.get(id)
    if (entry && entry.expiresAt <= now()) forget(id)
    return finished.get(id) ?? stubs.get(id) ?? dropped.get(id)
  }

  function keepStub(id: string, entry: Kept<InvokeResponse>): void {
    forget(id)
    stubs.set(id, { ...entry, expiresAt: now() + EXECUTION_TTL_MS, at: now() })
    trim(stubs, SCRIPT_STUB_LIMIT)
  }

  function keep(id: string, entry: Kept<InvokeResponse>, size: number, auditId: string): void {
    forget(id)
    const slot: BudgetSlot = { bytes: size, evict: () => { if (finished.get(id)?.slot === slot) drop(id) } }
    finished.set(id, { ...entry, expiresAt: now() + EXECUTION_TTL_MS, at: now(), slot, auditId })
    bytes += size
    budget.add(slot)
    for (const oldest of finished.keys()) {
      if (finished.size <= EXECUTION_LIMIT && bytes <= workspaceBytes) break
      drop(oldest)
    }
  }

  function earlier(key: ExecutionKey): Earlier | undefined {
    const id = executionId(key)
    const done = finishedFor(id)
    const found = done ? { fingerprint: done.fingerprint, outcome: Promise.resolve(done.outcome), at: done.at } : running.get(id)
    if (!found) return undefined
    if (found.fingerprint !== key.fingerprint) return { kind: 'reused' }
    return { kind: 'replay', response: found.outcome, ...('at' in found ? { at: found.at } : {}) }
  }

  return {
    earlier,
    forget: key => forget(executionId(key)),
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
          settle({ response, auditId, callerLeft, script }) {
            running.delete(id)
            const answer = started && callerLeft ? alreadyExecuted({ requestId: response.requestId, auditId, reason: 'interrupted' }) : response
            settled.resolve(answer)
            // A script that stopped at an ask ran, but asks again when re-sent (owner decision D82, point 6).
            if (!started || isRetryable(answer) || answer.outcome === 'approval_required') return
            if (script) return keepStub(id, { fingerprint: key.fingerprint, outcome: alreadyExecuted({ requestId: response.requestId, auditId, reason: 'script' }) })
            const size = responseBytes(answer)
            const kept = size <= EXECUTION_RESPONSE_BYTES ? answer : alreadyExecuted({ requestId: response.requestId, auditId, reason: 'too_large' })
            keep(id, { fingerprint: key.fingerprint, outcome: kept }, kept === answer ? size : responseBytes(kept), auditId)
          },
        },
      }
    },
  }
}

/** Drops a store's oldest stubs past `limit`; insertion order is age. */
function trim(stubs: Map<string, Stub>, limit: number): void {
  for (const oldest of stubs.keys()) {
    if (stubs.size <= limit) break
    stubs.delete(oldest)
  }
}

function executionId(key: Pick<ExecutionKey, 'sessionId' | 'actor' | 'requestId'>): string {
  return JSON.stringify([key.sessionId, key.actor ?? null, key.requestId])
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name]!)]))
}

function responseBytes(response: InvokeResponse): number {
  return Buffer.byteLength(JSON.stringify(response))
}

function isRetryable(response: InvokeResponse): boolean {
  return response.outcome === 'error' && response.error.retryable
}

const ALREADY_EXECUTED_MESSAGE = {
  interrupted: 'This requestId already started running and its caller left before it finished, so its effects are unknown; send a new requestId to run it again',
  too_large: 'This requestId already ran; its result was too large to keep for a re-send; send a new requestId to run it again',
  // Over MCP the next identical call is already a new one; over RPC a new requestId runs it again.
  evicted: 'This call already ran for this requestId, and Buckle no longer keeps its result to replay; the audit log shows what it did. Buckle did not run it again: to run it anew, send the call again (a new requestId, over RPC)',
  // A script cannot choose its calls' requestIds, so it is told how to run them again (owner decision D82).
  script: 'This call of the script already ran lately, and Buckle no longer keeps its result to replay; if it was cut short, its effects are unknown. Buckle did not run it again: change the script, even by a comment, to run it from its start',
} as const

/** A re-send's answer when the original response cannot be given: never retryable under the same requestId. */
function alreadyExecuted(input: { requestId: string; auditId: string; reason: keyof typeof ALREADY_EXECUTED_MESSAGE }): InvokeResponse {
  return { requestId: input.requestId, outcome: 'error', error: { code: REQUEST_ALREADY_EXECUTED, message: ALREADY_EXECUTED_MESSAGE[input.reason], retryable: false, details: { auditId: input.auditId, reason: input.reason } } }
}
