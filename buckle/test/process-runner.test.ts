import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOSE_GRACE_MS, runProcess } from '../common/adapters/process-runner.js'

// agent-browser's first call starts a background daemon that inherits the call's stdout and stderr, so the pipes stay
// open for the daemon's life: the runner waited on `close` and every first launch on the owner's node timed out.

const left: number[] = []
const folders: string[] = []
afterEach(() => {
  for (const pid of left.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function scratch(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-runner-')))
  folders.push(folder)
  return folder
}

/** A child that starts a detached grandchild holding its stdio, running `daemon`, names it, writes its own output, and exits. */
function parentOfDaemon(input: { daemon?: string } = {}): string {
  return [
    'const { spawn } = require("node:child_process")',
    `const daemon = spawn(process.execPath, ["-e", ${JSON.stringify(input.daemon ?? 'setTimeout(() => {}, 30000)')}], { detached: true, stdio: "inherit" })`,
    'daemon.unref()',
    'process.stdout.write(`daemon ${daemon.pid}\\nchild output\\n`)',
    'process.stderr.write("child warning\\n")',
  ].join('\n')
}

/**
 * A daemon that writes `marker` once its parent is gone for good: a process can be signalled until whoever started it
 * reaps it, and the runner's own exit handler runs as it reaps, so the marker means the runner has seen the exit.
 */
function daemonMarkingExit(marker: string): string {
  return `const parent = process.ppid; const watch = setInterval(() => { try { process.kill(parent, 0) } catch { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "exited"); clearInterval(watch) } }, 10); setTimeout(() => {}, 30000)`
}

/** The daemon's pid, read from what the child wrote, kept to be killed after the test. */
function daemonOf(stdout: string): number {
  const pid = Number(/daemon (\d+)/.exec(stdout)?.[1])
  if (pid) left.push(pid)
  return pid
}

async function until(done: () => boolean, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('the process runner', () => {
  it('settles within the grace after the process exits, though a process it started still holds the pipes', async () => {
    const started = Date.now()
    const result = await runProcess({ command: process.execPath, args: ['-e', parentOfDaemon()], cwd: '/tmp', environment: {}, timeoutMs: 20_000 })
    const pid = daemonOf(result.stdout)
    expect(Date.now() - started).toBeLessThan(CLOSE_GRACE_MS + 3_000)
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, truncated: false, stderr: 'child warning\n' })
    expect(result.stdout).toBe(`daemon ${pid}\nchild output\n`)
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  // Review of 2026-10-14: nothing showed the exit clearing the timeout, the pipes let go, or an abort in the grace.
  it('stops the timeout once the process exits, so one that ends inside the grace is no time-out', async () => {
    // Whenever the child exits before this timeout, the grace runs past it: only a cleared timer leaves timedOut false.
    const result = await runProcess({ command: process.execPath, args: ['-e', parentOfDaemon()], cwd: '/tmp', environment: {}, timeoutMs: CLOSE_GRACE_MS - 100 })
    daemonOf(result.stdout)
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false })
  })

  it('lets go of the pipes after the grace, so the process holding them writes into a closed pipe', async () => {
    const folder = scratch()
    const marker = join(folder, 'late-write')
    const record = `(code) => { try { require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(code), { flag: "wx" }) } catch {} }`
    const daemon = `const record = ${record}; process.stdout.on("error", error => record(error.code)); setTimeout(() => { try { process.stdout.write("late\\n", error => record(error ? error.code : "written")) } catch (error) { record(error.code) } }, ${CLOSE_GRACE_MS + 700}); setTimeout(() => {}, 30000)`
    const result = await runProcess({ command: process.execPath, args: ['-e', parentOfDaemon({ daemon })], cwd: '/tmp', environment: {}, timeoutMs: 20_000 })
    daemonOf(result.stdout)
    await until(() => existsSync(marker), 10_000)
    expect(readFileSync(marker, 'utf8')).toBe('EPIPE')
    expect(result.stdout).not.toContain('late')
  }, 20_000)

  it('keeps the exit\'s result when the call is aborted during the grace', async () => {
    const folder = scratch()
    const exited = join(folder, 'exited')
    const stop = new AbortController()
    const pending = runProcess({ command: process.execPath, args: ['-e', parentOfDaemon({ daemon: daemonMarkingExit(exited) })], cwd: '/tmp', environment: {}, timeoutMs: 20_000, signal: stop.signal })
    await until(() => existsSync(exited), 10_000)
    stop.abort()
    const result = await pending
    daemonOf(result.stdout)
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stderr: 'child warning\n' })
    expect(result.stdout).toContain('child output\n')
  }, 20_000)

  it('returns on close with all a plain process wrote', async () => {
    const script = 'for (let line = 0; line < 20000; line++) process.stdout.write(`line ${line}\\n`); process.stderr.write("done\\n")'
    const result = await runProcess({ command: process.execPath, args: ['-e', script], cwd: '/tmp', environment: {}, timeoutMs: 20_000 })
    const lines = result.stdout.split('\n')
    expect(lines).toHaveLength(20_001)
    expect(lines.at(-2)).toBe('line 19999')
    expect(result).toMatchObject({ exitCode: 0, stderr: 'done\n', timedOut: false })
  })

  // Review of 2026-10-14: a 300 ms timeout raced Node's start-up under load. The runner has no hook to start its timer
  // at the child's readiness, so the timeout is far past any start-up seen (35 to 330 ms under load), and the result
  // shows the child was ready (its output) and the timer ran its full length.
  it('still times out a process that does not exit, after it started, and reports it', async () => {
    const timeoutMs = 4_000
    const started = Date.now()
    const result = await runProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("started\\n"); setInterval(() => {}, 1000)'], cwd: '/tmp', environment: {}, timeoutMs })
    expect(Date.now() - started).toBeGreaterThanOrEqual(timeoutMs)
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGTERM', stdout: 'started\n' })
  }, 20_000)
})
