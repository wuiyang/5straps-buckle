import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileUrlPatterns } from '../common/domain/url-pattern.js'
import { createWebPack } from '../common/services/packs/web/index.js'

const CHUNK = 65_536
const CAP = 32 * CHUNK

interface Fetched { status: number; body: string; truncated: boolean }

/** A chunk of CHUNK bytes of one letter, so a result shows which chunks it holds and in what order. */
function block(index: number): Uint8Array {
  return new Uint8Array(CHUNK).fill(97 + (index % 26))
}

function blocks(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => block(index))
}

/**
 * A pull-based stream, so the end of it is learned only by reading once more, as on a network. After `parts`, `tail`
 * closes it, never answers, yields empty chunks without end, or fails it as a dropped connection does.
 */
function streamOf(parts: Uint8Array[], tail: 'close' | 'stall' | 'empties' | 'error' = 'close') {
  const state = { cancelled: false, pulls: 0 }
  let next = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1
      if (next < parts.length) {
        controller.enqueue(parts[next]!)
        next += 1
      } else if (tail === 'close') {
        controller.close()
      } else if (tail === 'empties') {
        controller.enqueue(new Uint8Array(0))
      } else if (tail === 'error') {
        controller.error(new Error('connection reset after the cap'))
      } else {
        return new Promise<void>(() => undefined)
      }
    },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  return { stream, state }
}

async function fetched(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Promise<Fetched> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers })))
  const tool = createWebPack({ approved: compileUrlPatterns(['decoy.example.test']) }).tools.find(candidate => candidate.capability.name === 'web_fetch')!
  const result = await tool.prepare({ url: 'http://decoy.example.test/data' }).execute({
    requestId: 'bounded', sessionId: 'bounded', timeoutMs: 5_000, signal: new AbortController().signal,
  })
  return result as unknown as Fetched
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('web_fetch against the 2 MiB response cap', () => {
  it('returns a response under the cap whole, untruncated, and cancels nothing', async () => {
    const { stream, state } = streamOf(blocks(31))
    const result = await fetched(stream)
    expect(result.body).toHaveLength(31 * CHUNK)
    expect(result.truncated).toBe(false)
    expect(state.cancelled).toBe(false)
  })

  it('returns a response of exactly the cap whole and untruncated, having learned that the stream ended', async () => {
    const { stream, state } = streamOf(blocks(32))
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.body[0]).toBe('a')
    expect(result.body.at(-1)).toBe(String.fromCharCode(97 + 31 % 26))
    expect(result.truncated).toBe(false)
    expect(state.cancelled).toBe(false)
  })

  it('marks truncated a response of one chunk more than the cap, returns the cap, and cancels the stream', async () => {
    const { stream, state } = streamOf(blocks(33))
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.body.at(-1)).toBe(String.fromCharCode(97 + 31 % 26))
    expect(result.truncated).toBe(true)
    expect(state.cancelled).toBe(true)
  })

  it('still marks truncated a chunk the cap cuts through', async () => {
    const { stream, state } = streamOf([...blocks(31), new Uint8Array(2 * CHUNK).fill(122)])
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(true)
    expect(state.cancelled).toBe(true)
  })

  it('reads past empty chunks after the cap and marks truncated when data follows them', async () => {
    const { stream, state } = streamOf([...blocks(32), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(100).fill(122)])
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(true)
    expect(state.cancelled).toBe(true)
  })

  it('does not count empty chunks after the cap as more data when the stream then ends', async () => {
    const { stream } = streamOf([...blocks(32), new Uint8Array(0), new Uint8Array(0)])
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(false)
  })

  it('gives up on an endless run of empty chunks after a handful of reads, and reports the response as not proven complete', async () => {
    const { stream, state } = streamOf(blocks(32), 'empties')
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(true)
    expect(state.cancelled).toBe(true)
    expect(state.pulls).toBeLessThan(32 + 20)
  })

  it('does not wait on a stream that stalls at the cap: after a second it is cancelled and marked truncated', async () => {
    vi.useFakeTimers()
    const { stream, state } = streamOf(blocks(32), 'stall')
    const pending = fetched(stream)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(true)
    expect(state.cancelled).toBe(true)
  })

  it('keeps the cap already read and marks truncated when the stream fails on the read just after it', async () => {
    const { stream } = streamOf(blocks(32), 'error')
    const result = await fetched(stream)
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(true)
  })

  it('still fails where the stream errors before the cap, as no body was read to keep', async () => {
    const { stream } = streamOf(blocks(3), 'error')
    await expect(fetched(stream)).rejects.toThrow('connection reset after the cap')
  })

  it('marks truncated a response whose content-length is over the cap, even where its body ends short', async () => {
    const { stream } = streamOf(blocks(3))
    const result = await fetched(stream, { 'content-length': String(CAP + 1) })
    expect(result.body).toHaveLength(3 * CHUNK)
    expect(result.truncated).toBe(true)
  })

  it('needs no wait at the cap when content-length already said the response is longer', async () => {
    const { stream, state } = streamOf(blocks(32), 'stall')
    const result = await fetched(stream, { 'content-length': String(CAP + CHUNK) })
    expect(result.body).toHaveLength(CAP)
    expect(result.truncated).toBe(true)
    expect(state.cancelled).toBe(true)
  })

  it('does not mark truncated a content-length of exactly the cap, or one that is not a number', async () => {
    expect((await fetched(streamOf(blocks(32)).stream, { 'content-length': String(CAP) })).truncated).toBe(false)
    expect((await fetched(streamOf(blocks(2)).stream, { 'content-length': 'many' })).truncated).toBe(false)
  })
})
