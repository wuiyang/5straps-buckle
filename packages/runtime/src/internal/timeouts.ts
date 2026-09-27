// Node timers overflow above this and fire at once.
export const MAX_TIMER_MS = 2 ** 31 - 1

export function assertTimerMs(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) throw new TypeError(`${name} must be an integer between 1 and ${MAX_TIMER_MS} ms; got ${value}`)
}

// True when every promise settled before the deadline; the timer never outlives the wait.
export async function settleWithin(work: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)) })
  try {
    return await Promise.race([Promise.allSettled(work).then(() => true), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
