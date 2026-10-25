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

/**
 * How many times the least processor time of a reading (leastProcessorTime) is that of the same reading on a tenth of
 * its input, timed just before it in the same thread. A slower machine slows both alike, so a limit on the ratio holds
 * on a CI runner as on a developer machine: three one-second rows took 1030 to 1187 ms on a GitHub runner, about 1.65
 * times what they took on the machine they were written on. A reading that grows with the square of its input reads
 * ten times the input a hundred times slower, and still fails LINEAR_TENFOLD_LIMIT.
 */
export function tenfoldProcessorRatio<T>(run: () => T, tenth: () => unknown, runs = 3): { ratio: number; result: T } {
  const calibration = leastProcessorTime(tenth, 5)
  const { milliseconds, result } = leastProcessorTime(run, runs)
  return { ratio: milliseconds / calibration.milliseconds, result }
}

/**
 * The ratio tenfoldProcessorRatio may reach. A linear reading's is about 10 (9.1 to 11.4 measured alone, 5.9 to 14.2
 * beside two busy loops), so this leaves it twice that and more; a quadratic reading's is about 100, and a reading made
 * ten times slower by a quadratic part reaches about 50.
 */
export const LINEAR_TENFOLD_LIMIT = 30
