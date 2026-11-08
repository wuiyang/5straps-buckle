import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogBudget, createLogQueue, type LogDrops } from '../../src/index.js'

// A writer that takes every batch and never finishes one, as a disk that stopped answering.
function stuckWriter<T>(): { batches: T[][]; write: (batch: readonly T[]) => Promise<void> } {
  const batches: T[][] = []
  return { batches, write: batch => { batches.push([...batch]); return new Promise<void>(() => {}) } }
}

function memoryWriter<T>(): { lines: T[]; write: (batch: readonly T[]) => void } {
  const lines: T[] = []
  return { lines, write: (batch) => { lines.push(...batch) } }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)
const drained = () => new Promise(resolve => setImmediate(resolve))

afterEach(() => { vi.useRealTimers() })

describe('one log queue under a budget', () => {
  it('holds 30 of 31 entries against a stuck writer, dropping the oldest, and every push returns at once', async () => {
    const writer = stuckWriter<number>()
    const budget = createLogBudget({ limit: 30, overflow: 'drop-oldest' })
    const queue = createLogQueue({ destination: 'node', budget, write: writer.write })
    const started = performance.now()
    for (const entry of range(0, 31)) queue.push(entry)
    expect(performance.now() - started).toBeLessThan(50)
    expect(writer.batches).toEqual([])
    await drained()
    expect(writer.batches).toEqual([range(1, 31)])
    expect(queue.stats()).toEqual({ held: 30, written: 0, dropped: 1, failures: 0 })
    expect(budget.held()).toBe(30)
  })

  it('holds 30 in all for four workspaces and the node log, dropping the oldest whichever log holds it', async () => {
    const budget = createLogBudget({ limit: 30, overflow: 'drop-oldest' })
    const writers = ['workspace-a', 'workspace-b', 'workspace-c', 'workspace-d', 'node'].map(destination => ({ destination, writer: stuckWriter<string>() }))
    const queues = writers.map(({ destination, writer }) => createLogQueue({ destination, budget, write: writer.write }))
    for (const queue of queues) for (const index of range(0, 10)) queue.push(`${queue.destination} ${index}`)
    expect(budget.held()).toBe(30)
    expect(queues.map(queue => [queue.destination, queue.stats().dropped])).toEqual([['workspace-a', 10], ['workspace-b', 10], ['workspace-c', 0], ['workspace-d', 0], ['node', 0]])
    await drained()
    expect(writers.map(({ writer }) => writer.batches.flat().length)).toEqual([0, 0, 10, 10, 10])
  })

  it('keeps what the writer holds and drops the new entry once every held entry is with the writer', async () => {
    const writer = stuckWriter<number>()
    const budget = createLogBudget({ limit: 3, overflow: 'drop-oldest' })
    const queue = createLogQueue({ destination: 'node', budget, write: writer.write })
    for (const entry of range(0, 3)) queue.push(entry)
    await drained()
    queue.push(3)
    await drained()
    expect(writer.batches).toEqual([[0, 1, 2]])
    expect(queue.stats()).toMatchObject({ held: 3, dropped: 1 })
  })

  it('drops the oldest waiting entry first when an entry waits for its retry', async () => {
    vi.useFakeTimers()
    const batches: string[][] = []
    let failures = 1
    const queue = createLogQueue<string>({
      destination: 'node',
      budget: createLogBudget({ limit: 3, overflow: 'drop-oldest' }),
      retryDelaysMs: [250],
      write: (batch) => {
        batches.push([...batch])
        if (failures-- > 0) throw new Error('disk full')
      },
      summarize: drops => `dropped ${drops.count}`,
    })
    queue.push('a')
    await vi.advanceTimersByTimeAsync(0)
    for (const entry of ['b', 'c', 'd']) queue.push(entry)
    await vi.advanceTimersByTimeAsync(250)
    expect(batches).toEqual([['a'], ['dropped 1', 'b', 'c', 'd']])
    expect(queue.stats()).toEqual({ held: 0, written: 3, dropped: 1, failures: 1 })
  })

  it('keeps today\'s defaults for other users: 1000 entries, the newest dropped, no retry', async () => {
    const writer = memoryWriter<number>()
    const queue = createLogQueue({ destination: 'node', write: writer.write })
    for (const entry of range(0, 1_001)) queue.push(entry)
    await queue.flush()
    expect(writer.lines).toEqual(range(0, 1_000))
    expect(queue.stats()).toMatchObject({ written: 1_000, dropped: 1 })

    let attempts = 0
    const failing = createLogQueue({ destination: 'node', write: () => { attempts += 1; throw new Error('disk full') } })
    failing.push(1)
    await failing.flush()
    expect([attempts, failing.stats().dropped]).toEqual([1, 1])
  })
})

describe('retries and the dropped-count entry', () => {
  it('tries a failed write again after 250 ms, 1 s, and 4 s, then drops it and writes the count before the next entry', async () => {
    vi.useFakeTimers()
    const batches: string[][] = []
    const summaries: LogDrops[] = []
    let failures = 4
    const queue = createLogQueue<string>({
      destination: 'node',
      budget: createLogBudget({ limit: 30, overflow: 'drop-oldest' }),
      retryDelaysMs: [250, 1_000, 4_000],
      write: (batch) => {
        batches.push([...batch])
        if (failures-- > 0) throw new Error('disk full')
      },
      summarize: (drops) => {
        summaries.push(drops)
        return `dropped ${drops.count}`
      },
    })
    queue.push('first')
    await vi.advanceTimersByTimeAsync(0)
    expect(batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(batches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(batches).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(batches).toEqual([['first'], ['first'], ['first'], ['first']])
    expect(queue.stats()).toEqual({ held: 0, written: 0, dropped: 1, failures: 4 })

    queue.push('next')
    await vi.advanceTimersByTimeAsync(0)
    expect(batches.at(-1)).toEqual(['dropped 1', 'next'])
    expect(summaries).toEqual([{ count: 1, firstAt: expect.any(String), lastAt: expect.any(String) }])
    expect(Date.parse(summaries[0]!.lastAt)).toBeGreaterThanOrEqual(Date.parse(summaries[0]!.firstAt))
    expect(queue.stats()).toEqual({ held: 0, written: 1, dropped: 1, failures: 4 })
  })

  it('warns once when an episode of drops starts, and again only after its count was written', async () => {
    const writer = memoryWriter<string>()
    const notices: unknown[] = []
    const queue = createLogQueue<string>({
      destination: 'workspace-a',
      budget: createLogBudget({ limit: 2, overflow: 'drop-oldest' }),
      write: writer.write,
      summarize: drops => `dropped ${drops.count}`,
      onDropping: notice => { notices.push(notice) },
    })
    for (const entry of ['a', 'b', 'c', 'd']) queue.push(entry)
    expect(notices).toEqual([{ destination: 'workspace-a', reason: 'full', limit: 2 }])
    await queue.flush()
    for (const entry of ['e', 'f', 'g']) queue.push(entry)
    await queue.flush()
    expect(writer.lines).toEqual(['dropped 2', 'c', 'd', 'dropped 1', 'f', 'g'])
    expect(notices).toEqual([{ destination: 'workspace-a', reason: 'full', limit: 2 }, { destination: 'workspace-a', reason: 'full', limit: 2 }])
  })

  it('names a write that failed its retries as the reason an episode started', async () => {
    const notices: unknown[] = []
    const queue = createLogQueue<string>({ destination: 'node', write: () => { throw new Error('disk full') }, onDropping: notice => { notices.push(notice) } })
    queue.push('lost')
    await queue.flush()
    expect(notices).toEqual([{ destination: 'node', reason: 'failed', limit: 1_000 }])
  })

  it('never lets a callback that throws reach the caller', async () => {
    const writer = memoryWriter<string>()
    const queue = createLogQueue<string>({
      destination: 'node',
      budget: createLogBudget({ limit: 1, overflow: 'drop-oldest' }),
      write: writer.write,
      summarize: () => { throw new Error('summary failed') },
      onDropping: () => { throw new Error('warning failed') },
    })
    expect(() => { queue.push('a'); queue.push('b') }).not.toThrow()
    await queue.flush()
    expect(writer.lines).toEqual(['b'])
  })
})

describe('closing a log queue', () => {
  it('writes what is queued, then counts a push after close as dropped', async () => {
    const writer = memoryWriter<number>()
    const budget = createLogBudget({ limit: 30, overflow: 'drop-oldest' })
    const queue = createLogQueue<number>({ destination: 'node', budget, write: async (batch) => { await new Promise(resolve => setTimeout(resolve, 5)); writer.write(batch) } })
    for (const entry of range(0, 3)) queue.push(entry)
    expect(await queue.close()).toEqual({ left: 0 })
    queue.push(4)
    expect(writer.lines).toEqual([0, 1, 2])
    expect(queue.stats()).toEqual({ held: 0, written: 3, dropped: 1, failures: 0 })
  })

  it('stops at its deadline against a stuck writer, counts what was left, and frees its share of the budget', async () => {
    const budget = createLogBudget({ limit: 30, overflow: 'drop-oldest' })
    const queue = createLogQueue({ destination: 'node', budget, write: stuckWriter<number>().write })
    for (const entry of range(0, 3)) queue.push(entry)
    const started = performance.now()
    expect(await queue.close({ deadlineMs: 50 })).toEqual({ left: 3 })
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(queue.stats()).toEqual({ held: 0, written: 0, dropped: 3, failures: 0 })
    expect(budget.held()).toBe(0)
  })

  it('stops a retry wait at its deadline', async () => {
    const queue = createLogQueue({ destination: 'node', retryDelaysMs: [60_000], write: () => { throw new Error('disk full') } })
    queue.push(1)
    const started = performance.now()
    expect(await queue.close({ deadlineMs: 50 })).toEqual({ left: 1 })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('leaves the budget once closed, so another log takes its room', async () => {
    const budget = createLogBudget({ limit: 2, overflow: 'drop-oldest' })
    const closing = createLogQueue({ destination: 'old', budget, write: stuckWriter<number>().write })
    closing.push(1)
    closing.push(2)
    await closing.close({ deadlineMs: 1 })
    const writer = memoryWriter<number>()
    const next = createLogQueue({ destination: 'new', budget, write: writer.write })
    next.push(3)
    next.push(4)
    await next.flush()
    expect([writer.lines, next.stats().dropped]).toEqual([[3, 4], 0])
  })
})

describe('log queue settings', () => {
  it('refuses a malformed limit, overflow rule, or retry delay', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => createLogBudget({ limit })).toThrow(TypeError)
    expect(() => createLogBudget({ limit: 1, overflow: 'drop-random' as 'drop-oldest' })).toThrow(TypeError)
    for (const retryDelaysMs of [[0], [-1], [1.5], 'fast' as unknown as number[]] as number[][]) expect(() => createLogQueue({ destination: 'node', retryDelaysMs, write: () => {} })).toThrow(TypeError)
    expect(() => createLogQueue({ destination: 'node', maxBatch: 0, write: () => {} })).toThrow(TypeError)
  })

  it('takes at most maxBatch entries into one write', async () => {
    const batches: number[][] = []
    const queue = createLogQueue<number>({ destination: 'node', maxBatch: 2, write: (batch) => { batches.push([...batch]) } })
    for (const entry of range(0, 5)) queue.push(entry)
    await queue.flush()
    expect(batches).toEqual([[0, 1], [2, 3], [4]])
  })
})
