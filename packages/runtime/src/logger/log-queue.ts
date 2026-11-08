import { runDetached } from '../internal/async-slots.js'
import { readOptionalTimer, readTimerList, settleWithin } from '../internal/timeouts.js'

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
  /**
   * A write unanswered by then counts as a failed attempt, and its entries may drop like waiting ones. None is sent again
   * while it is out, so none is written twice: one that answers late is written, or is tried again. None by default.
   */
  writeDeadlineMs?: number
  maxBatch?: number
  /** The entry that reports drops, written ahead of the next batch; undefined writes none. */
  summarize?(drops: LogDrops): T | undefined
  /** The first drop of an episode, which ends once a batch carrying its count is written. */
  onDropping?(notice: LogDropNotice): void
}

/** `expendable`: gives way to every other held entry, and never pushes one of another kind out of a full budget. */
export interface LogPushOptions {
  expendable?: boolean
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
  push(entry: T, options?: LogPushOptions): void
  flush(): Promise<void>
  /** Writes what is held; at the deadline, what is left is dropped, counted, and returned. */
  close(options?: { deadlineMs?: number }): Promise<{ left: number }>
  stats(): LogQueueStats
}

/** `onlyExpendable` narrows each to the member's expendable entries. */
interface BudgetMember {
  oldest(onlyExpendable: boolean): number | undefined
  dropOldest(onlyExpendable: boolean): void
}

interface BudgetState {
  limit: number
  overflow: LogOverflow
  held: number
  sequence: number
  members: Set<BudgetMember>
}

interface Held<T> { value: T; sequence: number; expendable: boolean }

interface Batch<T> {
  entries: Held<T>[]
  drops: LogDrops | undefined
  summary: T | undefined
  attempts: number
  writing: boolean
  /** An attempt past its deadline, still out: true once it wrote. */
  late: Promise<boolean> | undefined
  /** Entries the budget dropped while the late attempt carrying them was out. */
  droppedLate: number
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
  const writeDeadline = readOptionalTimer('Log queue writeDeadlineMs', options.writeDeadlineMs)
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

  // A batch waiting for its retry or for a late write gives up its oldest entries first; one being written keeps them.
  function droppable(): Held<T>[][] {
    return batch && !batch.writing ? [batch.entries, pending] : [pending]
  }

  function oldestHeld(onlyExpendable: boolean): { list: Held<T>[]; index: number } | undefined {
    for (const list of droppable()) {
      const index = onlyExpendable ? list.findIndex(held => held.expendable) : list.length > 0 ? 0 : -1
      if (index >= 0) return { list, index }
    }
    return undefined
  }

  const member: BudgetMember = {
    oldest(onlyExpendable) {
      const found = oldestHeld(onlyExpendable)
      return found?.list[found.index]?.sequence
    },
    dropOldest(onlyExpendable) {
      const found = oldestHeld(onlyExpendable)
      if (!found) return
      found.list.splice(found.index, 1)
      if (batch?.late && found.list === batch.entries) batch.droppedLate += 1
      budget.held -= 1
      countDrop(1, 'full')
    },
  }
  budget.members.add(member)

  function push(entry: T, pushOptions: LogPushOptions = {}): void {
    const expendable = pushOptions.expendable === true
    if (closed) {
      counts.dropped += 1
      return
    }
    if (!admit(budget, expendable)) return countDrop(1, 'full')
    budget.held += 1
    pending.push({ value: entry, sequence: budget.sequence++, expendable })
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
    return { entries: pending.splice(0, maxBatch), drops: summarized, summary: summarized && summarizeSafely(summarized), attempts: 0, writing: false, late: undefined, droppedLate: 0 }
  }

  async function writeBatch(current: Batch<T>): Promise<boolean> {
    const values = current.entries.map(held => held.value)
    const lines = current.summary === undefined ? values : [current.summary, ...values]
    if (lines.length === 0) return true
    current.writing = true
    try {
      const attempt = attemptWrite(lines)
      const answered = writeDeadline === undefined ? await attempt : await answerWithin(attempt, writeDeadline)
      if (answered === undefined) current.late = attempt
      if (answered !== true) counts.failures += 1
      return answered === true
    } finally {
      current.writing = false
    }
  }

  // The writer reports its own failure; the batch is retried or dropped and counted.
  function attemptWrite(lines: readonly T[]): Promise<boolean> {
    try {
      return Promise.resolve(options.write(lines)).then(() => true, () => false)
    } catch {
      return Promise.resolve(false)
    }
  }

  function settleWritten(current: Batch<T>): void {
    batch = undefined
    budget.held -= current.entries.length
    counts.written += current.entries.length
    if (current.drops && !drops) dropping = false
  }

  async function retryOrDrop(current: Batch<T>): Promise<void> {
    const wroteLate = await lateAnswer(current)
    if (stopped) return
    if (wroteLate) {
      retractLateDrops(current)
      return settleWritten(current)
    }
    current.attempts += 1
    const delay = retryDelays[current.attempts - 1]
    if (delay === undefined) return dropBatch(current)
    await waitOrStop(delay)
  }

  // Out until it answers, so a drop meanwhile is known to ride in it.
  async function lateAnswer(current: Batch<T>): Promise<boolean> {
    if (!current.late) return false
    try {
      return await current.late
    } finally {
      current.late = undefined
    }
  }

  // The late attempt carried the entries dropped while it was out, so they were written after all.
  function retractLateDrops(current: Batch<T>): void {
    if (current.droppedLate === 0) return
    counts.dropped -= current.droppedLate
    counts.written += current.droppedLate
    const left = (drops?.count ?? 0) - current.droppedLate
    drops = drops && left > 0 ? { ...drops, count: left } : undefined
    if (!drops) dropping = false
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

// Makes room, the oldest expendable entry giving way first; otherwise by the overflow rule, and an expendable entry never
// pushes out another kind. False drops the new entry.
function admit(budget: BudgetState, expendable: boolean): boolean {
  if (budget.held < budget.limit) return true
  const yielding = oldestMember(budget, true)
  if (yielding && (!expendable || budget.overflow === 'drop-oldest')) {
    yielding.dropOldest(true)
    return true
  }
  if (expendable || budget.overflow === 'drop-newest') return false
  const victim = oldestMember(budget, false)
  if (!victim) return false
  victim.dropOldest(false)
  return true
}

function oldestMember(budget: BudgetState, onlyExpendable: boolean): BudgetMember | undefined {
  let oldest: { member: BudgetMember; sequence: number } | undefined
  for (const member of budget.members) {
    const sequence = member.oldest(onlyExpendable)
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

// The attempt's answer, or undefined once the deadline passes first.
async function answerWithin(attempt: Promise<boolean>, deadlineMs: number): Promise<boolean | undefined> {
  let timer: NodeJS.Timeout | undefined
  const passed = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), deadlineMs) })
  try {
    return await Promise.race([attempt, passed])
  } finally {
    clearTimeout(timer)
  }
}

function readMaxBatch(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`Log queue maxBatch must be a positive integer; got ${String(value)}`)
  return value
}
