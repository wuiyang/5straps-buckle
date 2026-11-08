import { runDetached } from '../internal/async-slots.js'
import { readTimerList, settleWithin } from '../internal/timeouts.js'

export type LogOverflow = 'drop-newest' | 'drop-oldest'
const OVERFLOWS: readonly LogOverflow[] = ['drop-newest', 'drop-oldest']
export const DEFAULT_LOG_LIMIT = 1_000

export interface LogBudgetOptions {
  limit: number
  overflow?: LogOverflow
}

/** Entries held in memory, waiting or being written, across every queue that shares it. */
export interface LogBudget {
  readonly limit: number
  readonly overflow: LogOverflow
  held(): number
}

export interface LogDrops {
  count: number
  firstAt: string
  lastAt: string
}

export type LogDropReason = 'full' | 'failed'

export interface LogDropNotice {
  destination: string
  reason: LogDropReason
  limit: number
}

export interface LogQueueOptions<T> {
  destination: string
  write(batch: readonly T[]): void | Promise<void>
  budget?: LogBudget
  /** Waits before each further attempt at a failed batch; once they run out, its entries drop. */
  retryDelaysMs?: readonly number[]
  maxBatch?: number
  /** The entry that reports drops, written ahead of the next batch; undefined writes none. */
  summarize?(drops: LogDrops): T | undefined
  /** The first drop of an episode, which ends once a batch carrying its count is written. */
  onDropping?(notice: LogDropNotice): void
}

export interface LogQueueStats {
  held: number
  written: number
  dropped: number
  failures: number
}

/** push never throws or waits; a full budget or a write that fails its retries drops entries and counts them. */
export interface LogQueue<T> {
  readonly destination: string
  push(entry: T): void
  flush(): Promise<void>
  /** Writes what is held; at the deadline, what is left is dropped, counted, and returned. */
  close(options?: { deadlineMs?: number }): Promise<{ left: number }>
  stats(): LogQueueStats
}

interface BudgetMember {
  oldest(): number | undefined
  dropOldest(): void
}

interface BudgetState {
  limit: number
  overflow: LogOverflow
  held: number
  sequence: number
  members: Set<BudgetMember>
}

interface Held<T> { value: T; sequence: number }

interface Batch<T> {
  entries: Held<T>[]
  drops: LogDrops | undefined
  summary: T | undefined
  attempts: number
  writing: boolean
}

const budgetStates = new WeakMap<LogBudget, BudgetState>()

export function createLogBudget(options: LogBudgetOptions): LogBudget {
  const overflow = options.overflow ?? 'drop-newest'
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new TypeError(`Log budget limit must be a positive integer; got ${String(options.limit)}`)
  if (!OVERFLOWS.includes(overflow)) throw new TypeError(`Log budget overflow must be one of ${OVERFLOWS.join(', ')}; got ${String(overflow)}`)
  const state: BudgetState = { limit: options.limit, overflow, held: 0, sequence: 0, members: new Set() }
  const budget: LogBudget = { limit: state.limit, overflow, held: () => state.held }
  budgetStates.set(budget, state)
  return budget
}

export function createLogQueue<T>(options: LogQueueOptions<T>): LogQueue<T> {
  const budget = budgetStateOf(options.budget ?? createLogBudget({ limit: DEFAULT_LOG_LIMIT }))
  const retryDelays = readTimerList('Log queue retryDelaysMs', options.retryDelaysMs)
  const maxBatch = readMaxBatch(options.maxBatch)
  const pending: Held<T>[] = []
  const counts = { written: 0, dropped: 0, failures: 0 }
  let batch: Batch<T> | undefined
  let drops: LogDrops | undefined
  let dropping = false
  let closed = false
  let stopped = false
  let pumping: Promise<void> | undefined
  let wake: (() => void) | undefined

  // A batch waiting for its retry gives up its oldest entries first; one being written keeps them.
  function droppable(): Held<T>[] {
    return batch && !batch.writing && batch.entries.length > 0 ? batch.entries : pending
  }

  const member: BudgetMember = {
    oldest: () => droppable()[0]?.sequence,
    dropOldest() {
      droppable().shift()
      budget.held -= 1
      countDrop(1, 'full')
    },
  }
  budget.members.add(member)

  function push(entry: T): void {
    if (closed) {
      counts.dropped += 1
      return
    }
    if (!admit(budget)) return countDrop(1, 'full')
    budget.held += 1
    pending.push({ value: entry, sequence: budget.sequence++ })
    pumping ??= runDetached(() => pump())
  }

  async function pump(): Promise<void> {
    try {
      // Entries pushed in the same tick go out in one batch.
      await Promise.resolve()
      while (!stopped && (batch ??= takeBatch())) {
        const current = batch
        const written = await writeBatch(current)
        if (stopped) return
        if (written) settleWritten(current)
        else await retryOrDrop(current)
      }
    } finally {
      // In the same step as the last empty check, so no push lands between them unpumped.
      pumping = undefined
    }
  }

  function takeBatch(): Batch<T> | undefined {
    if (pending.length === 0) return undefined
    const summarized = drops
    drops = undefined
    return { entries: pending.splice(0, maxBatch), drops: summarized, summary: summarized && summarizeSafely(summarized), attempts: 0, writing: false }
  }

  async function writeBatch(current: Batch<T>): Promise<boolean> {
    const values = current.entries.map(held => held.value)
    const lines = current.summary === undefined ? values : [current.summary, ...values]
    if (lines.length === 0) return true
    current.writing = true
    try {
      await options.write(lines)
      return true
    } catch {
      // The writer reports its own failure; the batch is retried or dropped and counted.
      counts.failures += 1
      return false
    } finally {
      current.writing = false
    }
  }

  function settleWritten(current: Batch<T>): void {
    batch = undefined
    budget.held -= current.entries.length
    counts.written += current.entries.length
    if (current.drops && !drops) dropping = false
  }

  async function retryOrDrop(current: Batch<T>): Promise<void> {
    current.attempts += 1
    const delay = retryDelays[current.attempts - 1]
    if (delay === undefined) return dropBatch(current)
    await waitOrStop(delay)
  }

  // The batch's own count goes back unwritten, to be reported with the next one.
  function dropBatch(current: Batch<T>): void {
    batch = undefined
    budget.held -= current.entries.length
    if (current.drops) drops = mergeDrops(current.drops, drops)
    countDrop(current.entries.length, 'failed')
  }

  function countDrop(count: number, reason: LogDropReason): void {
    if (count === 0) return
    const at = new Date().toISOString()
    counts.dropped += count
    drops = mergeDrops(drops, { count, firstAt: at, lastAt: at })
    if (dropping) return
    dropping = true
    notifyDropping(reason)
  }

  function notifyDropping(reason: LogDropReason): void {
    guarded(() => options.onDropping?.({ destination: options.destination, reason, limit: budget.limit }))
  }

  function summarizeSafely(summarized: LogDrops): T | undefined {
    return guarded(() => options.summarize?.(summarized))
  }

  function waitOrStop(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
      wake = done
    })
  }

  async function flush(): Promise<void> {
    while (pumping) await pumping
  }

  async function close(closeOptions: { deadlineMs?: number } = {}): Promise<{ left: number }> {
    closed = true
    if (closeOptions.deadlineMs === undefined) await flush()
    else await settleWithin([flush()], closeOptions.deadlineMs)
    stopped = true
    pumping = undefined
    wake?.()
    const left = pending.length + (batch?.entries.length ?? 0)
    budget.held -= left
    counts.dropped += left
    pending.length = 0
    batch = undefined
    budget.members.delete(member)
    return { left }
  }

  return {
    destination: options.destination,
    push,
    flush,
    close,
    stats: () => ({ held: pending.length + (batch?.entries.length ?? 0), ...counts }),
  }
}

// A callback that throws must neither reach the caller of push nor stop the pump; the drop is counted either way.
function guarded<R>(callback: () => R): R | undefined {
  try {
    return callback()
  } catch {
    return undefined
  }
}

// Makes room by the budget's overflow rule; false drops the new entry.
function admit(budget: BudgetState): boolean {
  if (budget.held < budget.limit) return true
  if (budget.overflow === 'drop-newest') return false
  const victim = oldestMember(budget)
  if (!victim) return false
  victim.dropOldest()
  return true
}

function oldestMember(budget: BudgetState): BudgetMember | undefined {
  let oldest: { member: BudgetMember; sequence: number } | undefined
  for (const member of budget.members) {
    const sequence = member.oldest()
    if (sequence !== undefined && (oldest === undefined || sequence < oldest.sequence)) oldest = { member, sequence }
  }
  return oldest?.member
}

function mergeDrops(first: LogDrops | undefined, second: LogDrops | undefined): LogDrops | undefined {
  if (!first || !second) return first ?? second
  return {
    count: first.count + second.count,
    firstAt: first.firstAt < second.firstAt ? first.firstAt : second.firstAt,
    lastAt: first.lastAt > second.lastAt ? first.lastAt : second.lastAt,
  }
}

function budgetStateOf(budget: LogBudget): BudgetState {
  const state = budgetStates.get(budget)
  if (!state) throw new TypeError('A log budget must come from createLogBudget')
  return state
}

function readMaxBatch(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`Log queue maxBatch must be a positive integer; got ${String(value)}`)
  return value
}
