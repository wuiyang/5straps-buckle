/**
 * The wall-clock time a row timed by leastProcessorTime may take: it runs its reading four times or more, and a machine
 * loaded by other test workers stretched one such row past vitest's 5 s default (4 to 5.6 s seen). The processor-time
 * limit in the row stays the real check; this one only stops a row that hangs.
 */
export const PROCESSOR_TIME_ROW_TIMEOUT = 30_000

/**
 * The least processor time of this thread, in milliseconds, over a few timed runs of a reading after one untimed run,
 * and the last run's result. A loaded machine stretches the wall clock and a cold start slows the first run, but neither
 * adds much to the thread time of the fastest warm run, and the garbage collector's helper threads are not counted, so a
 * time limit on it fails only when the reading itself is slow (one-second rows timed by the wall clock failed at 1266 ms
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
