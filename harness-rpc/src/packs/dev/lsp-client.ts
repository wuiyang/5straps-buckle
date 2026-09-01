import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { connect } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { ToolExecutionError } from '../../domain/tool.js'
import { logger } from '../../logger.js'

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

  streams.input.on('data', (chunk: Buffer) => {
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
        messages.push(JSON.parse(body) as JsonRpcMessage)
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
        send({ id, method, params })
      })
    },

    notify: (method, params) => send({ method, params }),
    diagnosticsFor: uri => diagnostics.get(uri) ?? [],

    close() {
      for (const waiting of pending.values()) waiting.reject(new ToolExecutionError('LSP connection closed', { code: 'LSP_CLOSED' }))
      pending.clear()
      streams.onClose()
    },
  }
}

export function spawnLspServer(input: { command: string; args: string[]; cwd: string }): LspConnection {
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(input.command, input.args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (chunk: Buffer) => logger.warn('Language server stderr', { text: chunk.toString('utf8').slice(0, 500) }))
  return createLspConnection({ input: child.stdout, output: child.stdin, onClose: () => child.kill('SIGTERM') })
}

export function connectLspSocket(input: { port: number; host: string }): Promise<LspConnection> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ port: input.port, host: input.host }, () => {
      resolvePromise(createLspConnection({ input: socket, output: socket, onClose: () => socket.destroy() }))
    })
    socket.once('error', rejectPromise)
  })
}
