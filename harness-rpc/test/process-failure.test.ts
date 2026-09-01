import { describe, expect, it } from 'vitest'
import { describeProcessFailure } from '../src/packs/process-failure.js'
import type { ProcessResult } from '../src/ports/process-runner.js'

function result(overrides: Partial<ProcessResult>): ProcessResult {
  return { exitCode: 1, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, ...overrides }
}

describe('describeProcessFailure', () => {
  it('prefers stderr when the binary writes there', () => {
    const message = describeProcessFailure('git', result({ stderr: 'not a repository' }))
    expect(message).toBe('git failed (exit 1): not a repository')
  })

  it('falls back to stdout, which is where agent-browser reports its errors', () => {
    const message = describeProcessFailure('agent-browser', result({ stdout: 'chrome is not installed' }))
    expect(message).toBe('agent-browser failed (exit 1): chrome is not installed')
  })

  it('still names the exit code when both streams are empty', () => {
    expect(describeProcessFailure('agent-browser', result({ exitCode: 2 })))
      .toBe('agent-browser failed (exit 2) with no output')
  })

  it('reports a timeout as a timeout rather than an exit code', () => {
    const message = describeProcessFailure('pnpm', result({ timedOut: true, exitCode: null, stdout: 'building' }))
    expect(message).toBe('pnpm timed out: building')
  })

  it('names the signal when the process was killed', () => {
    const message = describeProcessFailure('rg', result({ exitCode: null, signal: 'SIGKILL' }))
    expect(message).toBe('rg failed (killed by SIGKILL) with no output')
  })
})
