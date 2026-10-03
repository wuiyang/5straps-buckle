/**
 * The least processor time of this thread, in milliseconds, over a few timed runs of a reading after one untimed run,
 * and the last run's result. A loaded machine stretches the wall clock and a cold start slows the first run, but neither
 * adds much to the thread time of the fastest warm run, and the garbage collector's helper threads are not counted, so a
 * time limit on it fails only when the reading itself is slow (the 7h to 7k review saw one-second rows fail at 1266 ms
 * and 2006 ms on a loaded machine). Nothing the run spawns is counted, so the run must spawn nothing.
 */
export function leastProcessorTime<T>(run: () => T, runs = 3): { milliseconds: number; result: T } {
  let milliseconds = Number.POSITIVE_INFINITY
  let result = run()
  for (let index = 0; index < runs; index++) {
    const started = process.threadCpuUsage()
    result = run()
    const used = process.threadCpuUsage(started)
    milliseconds = Math.min(milliseconds, (used.user + used.system) / 1_000)
  }
  return { milliseconds, result }
}
