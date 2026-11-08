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
    for (const entry of range(0, 31)) expect(queue.push(entry)).toBeUndefined()
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

  it('with no write deadline, keeps what the writer holds and drops the new entry once every held entry is with the writer', async () => {
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

  it('counts a write past its deadline as failed, drops its entries oldest first, and sends no second attempt while it is out', async () => {
    const batches: Array<Array<number | string>> = []
    let answer = () => {}
    const budget = createLogBudget({ limit: 3, overflow: 'drop-oldest' })
    const queue = createLogQueue<number | string>({
      destination: 'node',
      budget,
      writeDeadlineMs: 20,
      retryDelaysMs: [1],
      write: (batch) => {
        batches.push([...batch])
        return batches.length === 1 ? new Promise<void>((resolve) => { answer = resolve }) : undefined
      },
      summarize: drops => `dropped ${drops.count}`,
    })
    for (const entry of range(0, 3)) queue.push(entry)
    await drained()
    await new Promise(resolve => setTimeout(resolve, 40))
    queue.push(3)
    queue.push(4)
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(batches).toEqual([[0, 1, 2]])
    expect(queue.stats()).toEqual({ held: 3, written: 0, dropped: 2, failures: 1 })
    expect(budget.held()).toBe(3)
    answer()
    await queue.flush()
    // The late write carried the two the budget dropped, so they count as written, and no count of them is written.
    expect(batches).toEqual([[0, 1, 2], [3, 4]])
    expect(queue.stats()).toEqual({ held: 0, written: 5, dropped: 0, failures: 1 })
  })

  it('keeps counting what the budget dropped from a late write that then failed', async () => {
    const batches: Array<Array<number | string>> = []
    let fail = (_error: Error) => {}
    const queue = createLogQueue<number | string>({
      destination: 'node',
      budget: createLogBudget({ limit: 2, overflow: 'drop-oldest' }),
      writeDeadlineMs: 20,
      retryDelaysMs: [1],
      write: (batch) => {
        batches.push([...batch])
        return batches.length === 1 ? new Promise<void>((_resolve, reject) => { fail = reject }) : undefined
      },
      summarize: drops => `dropped ${drops.count}`,
    })
    queue.push(0)
    queue.push(1)
    await drained()
    await new Promise(resolve => setTimeout(resolve, 40))
    queue.push(2)
    fail(new Error('disk full'))
    await queue.flush()

    expect(batches).toEqual([[0, 1], [1], ['dropped 1', 2]])
    expect(queue.stats()).toEqual({ held: 0, written: 2, dropped: 1, failures: 1 })
  })

  it('takes a write that answers after its deadline as written, and tries it again only when it failed', async () => {
    const batches: string[][] = []
    const answers = [{ wrote: true, afterMs: 40 }, { wrote: false, afterMs: 40 }, { wrote: true, afterMs: 0 }]
    const queue = createLogQueue<string>({
      destination: 'node',
      writeDeadlineMs: 10,
      retryDelaysMs: [1, 1],
      write: async (batch) => {
        batches.push([...batch])
        const answer = answers.shift()
        await new Promise(resolve => setTimeout(resolve, answer?.afterMs))
        if (!answer?.wrote) throw new Error('disk full')
      },
    })
    queue.push('late')
    await queue.flush()
    queue.push('failed late')
    await queue.flush()

    expect(batches).toEqual([['late'], ['failed late'], ['failed late']])
    expect(queue.stats()).toEqual({ held: 0, written: 2, dropped: 0, failures: 2 })
  })

  it('drops an expendable entry first to make room, so a flood of them never pushes out another kind', async () => {
    const writer = stuckWriter<string>()
    const budget = createLogBudget({ limit: 3, overflow: 'drop-oldest' })
    const queue = createLogQueue({ destination: 'workspace-a', budget, write: writer.write })
    const node = createLogQueue({ destination: 'node', budget, write: stuckWriter<string>().write })
    queue.push('decision')
    for (const index of range(0, 100)) queue.push(`refusal ${index}`, { expendable: true })
    node.push('line')
    await drained()

    expect(writer.batches).toEqual([['decision', 'refusal 99']])
    expect(budget.held()).toBe(3)
    expect([queue.stats().dropped, node.stats().dropped]).toEqual([99, 0])
  })

  it('drops a new expendable entry when only other kinds are held, and under drop-newest', async () => {
    for (const overflow of ['drop-oldest', 'drop-newest'] as const) {
      const writer = stuckWriter<string>()
      const queue = createLogQueue({ destination: 'node', budget: createLogBudget({ limit: 2, overflow }), write: writer.write })
      queue.push('a')
      queue.push('b')
      queue.push('refusal', { expendable: true })
      await drained()
      expect(writer.batches, overflow).toEqual([['a', 'b']])
    }
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
    vi.useFakeTimers()
    const budget = createLogBudget({ limit: 30, overflow: 'drop-oldest' })
    const queue = createLogQueue({ destination: 'node', budget, write: stuckWriter<number>().write })
    for (const entry of range(0, 3)) queue.push(entry)
    const closing = queue.close({ deadlineMs: 50 })
    await vi.advanceTimersByTimeAsync(49)
    expect(queue.stats().held).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(await closing).toEqual({ left: 3 })
    expect(queue.stats()).toEqual({ held: 0, written: 0, dropped: 3, failures: 0 })
    expect(budget.held()).toBe(0)
  })

  it('stops a retry wait at its deadline', async () => {
    vi.useFakeTimers()
    const queue = createLogQueue({ destination: 'node', retryDelaysMs: [60_000], write: () => { throw new Error('disk full') } })
    queue.push(1)
    await vi.advanceTimersByTimeAsync(0)
    const closing = queue.close({ deadlineMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await closing).toEqual({ left: 1 })
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

describe('the entries a log queue drops', () => {
  it('hands onDropped each entry as it drops: the oldest for room, a new one refused, and a batch past its retries', async () => {
    vi.useFakeTimers()
    const heard: Array<[string, number[]]> = []
    const hear = (destination: string) => (entries: readonly number[]) => { heard.push([destination, [...entries]]) }
    const oldest = createLogQueue<number>({ destination: 'oldest', budget: createLogBudget({ limit: 2, overflow: 'drop-oldest' }), write: stuckWriter<number>().write, onDropped: hear('oldest') })
    for (const entry of range(0, 3)) oldest.push(entry)
    const newest = createLogQueue<number>({ destination: 'newest', budget: createLogBudget({ limit: 2 }), write: stuckWriter<number>().write, onDropped: hear('newest') })
    for (const entry of range(0, 3)) newest.push(entry)
    const failing = createLogQueue<number>({ destination: 'failing', retryDelaysMs: [10], write: () => { throw new Error('disk full') }, onDropped: hear('failing') })
    failing.push(0)
    failing.push(1)
    await vi.advanceTimersByTimeAsync(10)

    expect(heard).toEqual([['oldest', [0]], ['newest', [2]], ['failing', [0, 1]]])
  })

  it('hands onDropped what it leaves at close, and an entry pushed after', async () => {
    const heard: number[][] = []
    const queue = createLogQueue<number>({ destination: 'node', maxBatch: 2, write: stuckWriter<number>().write, onDropped: (entries) => { heard.push([...entries]) } })
    for (const entry of range(0, 3)) queue.push(entry)
    await drained()
    await queue.close({ deadlineMs: 1 })
    queue.push(3)

    expect(heard).toEqual([[0, 1, 2], [3]])
  })

  it('never lets an onDropped that throws reach the caller', () => {
    const queue = createLogQueue<string>({ destination: 'node', budget: createLogBudget({ limit: 1, overflow: 'drop-oldest' }), write: stuckWriter<string>().write, onDropped: () => { throw new Error('hook failed') } })
    expect(() => { queue.push('a'); queue.push('b') }).not.toThrow()
    expect(queue.stats().dropped).toBe(1)
  })
})

describe('log queue settings', () => {
  it('refuses a malformed limit, overflow rule, or retry delay', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => createLogBudget({ limit })).toThrow(TypeError)
    expect(() => createLogBudget({ limit: 1, overflow: 'drop-random' as 'drop-oldest' })).toThrow(TypeError)
    for (const retryDelaysMs of [[0], [-1], [1.5], 'fast' as unknown as number[]] as number[][]) expect(() => createLogQueue({ destination: 'node', retryDelaysMs, write: () => {} })).toThrow(TypeError)
    expect(() => createLogQueue({ destination: 'node', maxBatch: 0, write: () => {} })).toThrow(TypeError)
    for (const writeDeadlineMs of [0, -1, 1.5]) expect(() => createLogQueue({ destination: 'node', writeDeadlineMs, write: () => {} })).toThrow(TypeError)
  })

  it('takes at most maxBatch entries into one write', async () => {
    const batches: number[][] = []
    const queue = createLogQueue<number>({ destination: 'node', maxBatch: 2, write: (batch) => { batches.push([...batch]) } })
    for (const entry of range(0, 5)) queue.push(entry)
    await queue.flush()
    expect(batches).toEqual([[0, 1], [2, 3], [4]])
  })
})
