import { Worker } from 'node:worker_threads'

/** One line a pattern matched: its 1-based number, its text without the line ending, and each match as a start and end in UTF-8 bytes. */
export interface MatchedLine { line: number; text: string; ranges: Array<{ start: number; end: number }> }

/** How long the pattern may take on one file before the search stops (a coordinator default, reversible). */
export const MATCH_TIMEOUT_MS = 5_000

/**
 * The worker could not answer for one file: the pattern ran past its bound on it, or the worker ended, failed, or could not
 * be started. The search leaves that file out (`timeout`) and goes on with a new worker; a cancel or the call's deadline
 * is no such failure, and ends the search with the signal's own reason.
 */
export class MatchFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MatchFailedError'
  }
}

export interface LineMatcher {
  /** The lines of a file's bytes the pattern matches, at most `limit` of them. */
  search(content: Buffer, limit: number): Promise<MatchedLine[]>
  close(): void
}

/**
 * The regular expression run for the built-in search, in a worker thread. A JavaScript regular expression backtracks,
 * and one that does it without end, such as `(a+)+$` on a line of a's, cannot be interrupted where it runs: on the
 * node's own thread it would stall every session past the call's timeout, where ripgrep's engine never did. Here the
 * node waits on the worker, so the call's timeout and cancel end it. A file that takes the pattern longer than `timeoutMs`,
 * or a worker that fails, rejects that one file's search with a MatchFailedError and stops the worker. The worker is started
 * by the first file and kept for the search.
 */
export function createLineMatcher(input: { source: string; flags: string; signal: AbortSignal; timeoutMs?: number }): LineMatcher {
  let worker: Worker | undefined
  const timeoutMs = input.timeoutMs ?? MATCH_TIMEOUT_MS
  return {
    search(content, limit) {
      return new Promise<MatchedLine[]>((resolve, reject) => {
        let running: Worker
        try {
          running = worker ??= new Worker(WORKER_SOURCE, { eval: true, workerData: { source: input.source, flags: input.flags } })
        } catch (error) {
          reject(new MatchFailedError('The search worker could not be started', { cause: error }))
          return
        }
        // A copy the worker takes over, so a slab a small file was read into is not shared.
        const bytes = new Uint8Array(content)
        let settled = false
        const settle = (finish: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          input.signal.removeEventListener('abort', onAbort)
          running.off('message', onMessage)
          running.off('error', onError)
          running.off('exit', onExit)
          finish()
        }
        const stop = (error: unknown) => settle(() => { worker = undefined; void running.terminate(); reject(error) })
        const onMessage = (message: { found: MatchedLine[] }) => settle(() => resolve(message.found))
        const onError = (error: Error) => stop(new MatchFailedError('The search worker failed', { cause: error }))
        const onExit = () => stop(new MatchFailedError('The search worker ended before it answered'))
        const onAbort = () => stop(input.signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
        const timer = setTimeout(() => stop(new MatchFailedError(`The pattern took more than ${timeoutMs / 1000} seconds on one file`)), timeoutMs)
        running.on('message', onMessage)
        running.on('error', onError)
        running.on('exit', onExit)
        if (input.signal.aborted) { onAbort(); return }
        input.signal.addEventListener('abort', onAbort, { once: true })
        running.postMessage({ bytes, limit }, [bytes.buffer])
      })
    },
    close() {
      const running = worker
      worker = undefined
      void running?.terminate()
    },
  }
}

/** The worker's program: the same line loop and byte ranges the ripgrep path reports, run on one file's bytes. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const pattern = new RegExp(workerData.source, workerData.flags)
parentPort.on('message', (message) => {
  const text = Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength).toString('utf8')
  const lines = text.split('\\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const found = []
  for (let index = 0; index < lines.length && found.length < message.limit; index++) {
    const raw = lines[index]
    const line = raw.endsWith('\\r') ? raw.slice(0, -1) : raw
    const ranges = []
    pattern.lastIndex = 0
    for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
      const start = Buffer.byteLength(line.slice(0, match.index))
      ranges.push({ start, end: start + Buffer.byteLength(match[0]) })
      if (match[0] === '') pattern.lastIndex++
    }
    if (ranges.length > 0) found.push({ line: index + 1, text: line, ranges })
  }
  parentPort.postMessage({ found })
})
`
