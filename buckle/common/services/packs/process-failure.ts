import type { ProcessResult } from '../../types/ports/process-runner.js'

/**
 * Builds a failure message from whichever stream carries the error. Plenty of CLIs report
 * failures on stdout, and reading stderr alone turns those into an empty message that tells the
 * caller nothing about what went wrong.
 */
export function describeProcessFailure(binary: string, result: ProcessResult): string {
  const detail = result.stderr.trim() || result.stdout.trim()
  if (result.timedOut) return `${binary} timed out${detail ? `: ${detail}` : ''}`

  const status = result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`
  return detail ? `${binary} failed (${status}): ${detail}` : `${binary} failed (${status}) with no output`
}
