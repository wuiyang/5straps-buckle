import { describe, expect, it } from 'vitest'
import { runProcess } from '../src/adapters/process-runner.js'

describe('process cancellation', () => {
  it('refuses to spawn an already cancelled request', async () => {
    await expect(runProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '/tmp', environment: {}, timeoutMs: 5000, signal: AbortSignal.abort() })).rejects.toThrow('already cancelled')
  })

  it('escalates cancellation when a process ignores SIGTERM', async () => {
    const controller = new AbortController()
    const pending = runProcess({ command: process.execPath, args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], cwd: '/tmp', environment: {}, timeoutMs: 10000, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 500)
    try {
      const result = await pending
      expect(result.signal).toBe('SIGKILL')
      expect(result.timedOut).toBe(false)
    } finally { clearTimeout(timer) }
  })
})
