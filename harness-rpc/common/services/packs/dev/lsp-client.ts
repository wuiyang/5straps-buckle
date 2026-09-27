import { buildChildEnvironment } from '../../../domain/environment.js'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { connect } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { ToolExecutionError } from '../../../domain/tool.js'
import { logger } from '../../../runtime/logger.js'

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const HEADER_TERMINATOR = '\r\n\r\n'

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export interface LspConnection {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  notify(method: string, params: unknown): void
  diagnosticsFor(uri: string): unknown[]
  close(): void
}

/** Minimal LSP client: Content-Length framing, id correlation, and buffered diagnostics. */
export function createLspConnection(streams: { input: Readable; output: Writable; onClose: () => void }): LspConnection {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const diagnostics = new Map<string, unknown[]>()
  let nextId = 1
  let buffer = Buffer.alloc(0)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    for (const waiting of pending.values()) waiting.reject(new ToolExecutionError('LSP connection closed', { code: 'LSP_CLOSED' }))
    pending.clear()
    diagnostics.clear()
    buffer = Buffer.alloc(0)
    streams.onClose()
  }
  streams.input.once('end', close)
  streams.input.on('error', close)
  streams.output.on('error', close)

  streams.input.on('data', (chunk: Buffer) => {
    if (closed) return
    if (buffer.byteLength + chunk.byteLength > MAX_FRAME_BYTES) { logger.warn('Closing oversized LSP stream'); close(); return }
    buffer = Buffer.concat([buffer, chunk])
    for (const message of drainMessages()) handleMessage(message)
  })

  function drainMessages(): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = []
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_TERMINATOR)
      if (headerEnd === -1) return messages

      const header = buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number.parseInt(header.match(/content-length:\s*(\d+)/i)?.[1] ?? '', 10)
      if (length > MAX_FRAME_BYTES) { logger.warn('Closing oversized LSP frame'); close(); return messages }
      if (!Number.isSafeInteger(length)) {
        logger.warn('Dropping LSP frame without a valid Content-Length')
        buffer = buffer.subarray(headerEnd + HEADER_TERMINATOR.length)
        continue
      }

      const bodyStart = headerEnd + HEADER_TERMINATOR.length
      if (buffer.byteLength < bodyStart + length) return messages

      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      try {
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { logger.warn('Dropping invalid LSP message'); continue }
        messages.push(parsed as JsonRpcMessage)
      } catch {
        logger.warn('Dropping unparseable LSP frame')
      }
    }
  }

  function handleMessage(message: JsonRpcMessage): void {
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined
      if (params?.uri) diagnostics.set(params.uri, params.diagnostics ?? [])
      return
    }
    if (typeof message.id !== 'number') return

    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new ToolExecutionError(`LSP error: ${message.error.message}`, { code: 'LSP_ERROR' }))
    else waiting.resolve(message.result)
  }

  function send(payload: Record<string, unknown>): void {
    if (closed) throw new ToolExecutionError('LSP connection closed', { code: 'LSP_CLOSED' })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...payload }), 'utf8')
    streams.output.write(`Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`)
    streams.output.write(body)
  }

  return {
    request(method, params, timeoutMs) {
      const id = nextId++
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(new ToolExecutionError(`LSP request ${method} timed out`, { code: 'LSP_TIMEOUT', retryable: true }))
        }, timeoutMs)

        pending.set(id, {
          resolve: value => {
            clearTimeout(timer)
            resolvePromise(value)
          },
          reject: error => {
            clearTimeout(timer)
            rejectPromise(error)
          },
        })
        try { send({ id, method, params }) } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          rejectPromise(error)
        }
      })
    },

    notify: (method, params) => send({ method, params }),
    diagnosticsFor: uri => diagnostics.get(uri) ?? [],

    close,
  }
}

export function spawnLspServer(input: { command: string; args: string[]; cwd: string }): LspConnection {
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: buildChildEnvironment({ parent: process.env, extra: {} }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (chunk: Buffer) => logger.warn('Language server wrote stderr', { bytes: chunk.byteLength }))
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const connection = createLspConnection({ input: child.stdout, output: child.stdin, onClose: () => {
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
    killTimer.unref()
  } })
  child.once('error', () => { logger.warn('Language server process failed'); connection.close() })
  child.once('exit', () => { connection.close(); clearTimeout(killTimer) })
  return connection
}

export function connectLspSocket(input: { port: number; host: string }): Promise<LspConnection> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ port: input.port, host: input.host }, () => {
      resolvePromise(createLspConnection({ input: socket, output: socket, onClose: () => socket.destroy() }))
    })
    socket.once('error', rejectPromise)
  })
}
