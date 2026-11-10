import type { Interface } from 'node:readline'
import type { Readable } from 'node:stream'

/**
 * How long the keyboard must be still, with a question on screen, before a key can answer it.
 * Longer than a double press or a reflex after the previous question ended, so a key meant for
 * that question lands nowhere instead of on one the owner has not read.
 */
export const QUIET_MS = 500

export interface KeyWatch {
  quiet(ms: number, signal: AbortSignal): Promise<void>
  stop(): void
}

/**
 * Notes when keys arrive. Remove it before the readline closes: a data listener left on the
 * terminal keeps it flowing, and so keeps the process alive.
 */
export function watchKeys(input: Readable): KeyWatch {
  let lastKeyAt = performance.now()
  const heard = () => { lastKeyAt = performance.now() }
  input.on('data', heard)
  return {
    async quiet(ms, signal) {
      const from = performance.now()
      while (!signal.aborted) {
        const still = performance.now() - Math.max(lastKeyAt, from)
        if (still >= ms) return
        await pause(ms - still, signal)
      }
    },
    stop() { input.off('data', heard) },
  }
}

/**
 * Throws away a line typed but not entered before a question opens. readline keeps it, so
 * without this the Enter that follows would answer the new question with the old keys.
 */
export function discardTypedLine(readline: Interface): void {
  if (!readline.terminal || readline.line === '') return
  readline.write(null, { ctrl: true, name: 'e' })
  readline.write(null, { ctrl: true, name: 'u' })
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
