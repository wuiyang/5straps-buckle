import { spawn } from 'node:child_process'
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../ports/process-runner.js'

const MAX_OUTPUT_BYTES = 1_048_576
const KILL_GRACE_MS = 1_000

/** Returns whatever the process produced, including on timeout. A killed build still has output. */
export const runProcess: ProcessRunner = (request: ProcessRequest): Promise<ProcessResult> => {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdout = createBoundedBuffer()
    const stderr = createBoundedBuffer()
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))

    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
    }, request.timeoutMs)

    const abort = (): void => {
      child.kill('SIGTERM')
    }
    request.signal?.addEventListener('abort', abort, { once: true })

    const cleanup = (): void => {
      clearTimeout(killTimer)
      request.signal?.removeEventListener('abort', abort)
    }

    child.once('error', error => {
      cleanup()
      rejectPromise(error)
    })

    child.once('close', (exitCode, signal) => {
      cleanup()
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
      })
    })
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
