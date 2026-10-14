import { afterEach, describe, expect, it } from 'vitest'
import { CLOSE_GRACE_MS, runProcess } from '../common/adapters/process-runner.js'

// agent-browser's first call starts a background daemon that inherits the call's stdout and stderr, so the pipes stay
// open for the daemon's life: the runner waited on `close` and every first launch on the owner's node timed out.

const left: number[] = []
afterEach(() => {
  for (const pid of left.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

/** A child that starts a detached grandchild holding its stdio for 30 s, names it, writes its own output, and exits. */
const PARENT_OF_DAEMON = [
  'const { spawn } = require("node:child_process")',
  'const daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "inherit" })',
  'daemon.unref()',
  'process.stdout.write(`daemon ${daemon.pid}\\nchild output\\n`)',
  'process.stderr.write("child warning\\n")',
].join('\n')

describe('the process runner', () => {
  it('settles within the grace after the process exits, though a process it started still holds the pipes', async () => {
    const started = Date.now()
    const result = await runProcess({ command: process.execPath, args: ['-e', PARENT_OF_DAEMON], cwd: '/tmp', environment: {}, timeoutMs: 20_000 })
    const pid = Number(/daemon (\d+)/.exec(result.stdout)?.[1])
    if (pid) left.push(pid)
    expect(Date.now() - started).toBeLessThan(CLOSE_GRACE_MS + 3_000)
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, truncated: false, stderr: 'child warning\n' })
    expect(result.stdout).toBe(`daemon ${pid}\nchild output\n`)
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('returns on close with all a plain process wrote', async () => {
    const script = 'for (let line = 0; line < 20000; line++) process.stdout.write(`line ${line}\\n`); process.stderr.write("done\\n")'
    const result = await runProcess({ command: process.execPath, args: ['-e', script], cwd: '/tmp', environment: {}, timeoutMs: 20_000 })
    const lines = result.stdout.split('\n')
    expect(lines).toHaveLength(20_001)
    expect(lines.at(-2)).toBe('line 19999')
    expect(result).toMatchObject({ exitCode: 0, stderr: 'done\n', timedOut: false })
  })

  it('still times out a process that does not exit, and reports it', async () => {
    const result = await runProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("started\\n"); setInterval(() => {}, 1000)'], cwd: '/tmp', environment: {}, timeoutMs: 300 })
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGTERM', stdout: 'started\n' })
  })
})
