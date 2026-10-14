import { spawn } from 'node:child_process'
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../types/ports/process-runner.js'

const MAX_OUTPUT_BYTES = 1_048_576
const KILL_GRACE_MS = 1_000
/**
 * How long a process that exited is given for its pipes to close. A program that leaves a process behind holding them,
 * as agent-browser's first call starts its daemon, never closes them, and the call waited on `close` for the daemon's
 * whole life, which timed the owner's first launches out (2026-10-14).
 */
export const CLOSE_GRACE_MS = 2_000

/**
 * Returns whatever the process produced, including on timeout. A killed build still has output. It settles once the
 * process exits and its pipes close, or CLOSE_GRACE_MS after the exit if they stay open, with the output read by then;
 * the pipes are then let go.
 */
export const runProcess: ProcessRunner = (request: ProcessRequest): Promise<ProcessResult> => {
  return new Promise((resolvePromise, rejectPromise) => {
    if (request.signal?.aborted) { rejectPromise(new Error('Process request was already cancelled')); return }
    const child = spawn(request.command, request.args, {
      argv0: request.argv0,
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: [request.stdin ?? 'ignore', 'pipe', 'pipe'],
    })

    const stdout = createBoundedBuffer()
    const stderr = createBoundedBuffer()
    let timedOut = false

    if (!child.stdout || !child.stderr) throw new Error('Process output pipes were not created')
    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))

    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (): void => {
      child.kill('SIGTERM')
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      forceKillTimer.unref()
    }
    const killTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, request.timeoutMs)
    request.signal?.addEventListener('abort', terminate, { once: true })
    if (request.signal?.aborted) terminate()

    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(killTimer)
      clearTimeout(forceKillTimer)
      clearTimeout(graceTimer)
      request.signal?.removeEventListener('abort', terminate)
    }

    let settled = false
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
      })
    }

    child.once('error', error => {
      cleanup()
      rejectPromise(error)
    })

    child.once('exit', (exitCode, signal) => {
      // The process is gone, so nothing is left to time out or kill; what another process still holds is given a grace.
      clearTimeout(killTimer)
      clearTimeout(forceKillTimer)
      graceTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(exitCode, signal)
      }, CLOSE_GRACE_MS)
    })

    child.once('close', (exitCode, signal) => settle(exitCode, signal))
  })
}

function createBoundedBuffer() {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false

  return {
    get truncated(): boolean {
      return truncated
    },
    append(chunk: Buffer): void {
      const remaining = MAX_OUTPUT_BYTES - size
      if (remaining <= 0) {
        truncated = true
        return
      }
      if (chunk.byteLength > remaining) truncated = true
      const slice = chunk.subarray(0, remaining)
      chunks.push(slice)
      size += slice.byteLength
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}
