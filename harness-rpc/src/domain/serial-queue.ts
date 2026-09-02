export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Runs tasks one after another, in the order they were submitted.
 *
 * Used where a resource cannot be shared or navigated, a terminal above all: two questions
 * printed at once would interleave and race for the same keystroke, so an answer could land on
 * a request that arrived while the person was reading a different one.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()

  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task)
    // A failed task must not poison the queue for whatever is waiting behind it.
    tail = result.catch(() => undefined)
    return result
  }
}
