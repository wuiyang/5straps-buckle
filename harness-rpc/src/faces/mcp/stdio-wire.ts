import { isUtf8 } from 'node:buffer'
import type { Readable, Writable } from 'node:stream'
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server'

/** The SDK's default ReadBuffer drops JSON syntax errors; this framing boundary reports them. */
export function createStdioWire(input: { stdin: Readable; stdout: Writable; maxBufferBytes: number }): Transport {
  if (!Number.isSafeInteger(input.maxBufferBytes) || input.maxBufferBytes < 1) throw new Error('Invalid MCP stdio buffer limit')
  let buffer: Buffer = Buffer.alloc(0)
  let started = false
  let closed = false
  const transport: Transport = {
    async start() {
      if (started || closed) throw new Error('MCP stdio transport cannot start twice')
      started = true
      input.stdin.on('data', onData)
      input.stdin.on('end', onEnd)
      input.stdin.on('error', onStreamError)
      input.stdout.on('error', onStreamError)
    },
    async send(message) {
      if (closed) throw new Error('MCP stdio transport is closed')
      await new Promise<void>((resolve, reject) => {
        const onError = () => reject(new Error('MCP stdio write failed'))
        input.stdout.once('error', onError)
        try {
          input.stdout.write(serializeMessage(message), error => {
            if (error) { reject(new Error('MCP stdio write failed')); return }
            input.stdout.off('error', onError)
            resolve()
          })
        } catch {
          input.stdout.off('error', onError)
          reject(new Error('MCP stdio write failed'))
        }
      })
    },
    async close() {
      if (closed) return
      closed = true
      input.stdin.off('data', onData)
      input.stdin.off('end', onEnd)
      input.stdin.off('error', onStreamError)
      input.stdout.off('error', onStreamError)
      if (input.stdin.listenerCount('data') === 0) input.stdin.pause()
      buffer = Buffer.alloc(0)
      transport.onclose?.()
    },
  }
  return transport

  function onData(chunk: Buffer | string): void {
    if (closed) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (buffer.length + bytes.length > input.maxBufferBytes) {
      transport.onerror?.(new Error('MCP stdio input exceeds the buffer limit'))
      void transport.close()
      return
    }
    buffer = Buffer.concat([buffer, bytes])
    while (!closed) {
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      let message: JSONRPCMessage
      try {
        if (!isUtf8(line)) throw new Error('Invalid UTF-8')
        message = deserializeMessage(line.toString('utf8').replace(/\r$/, ''))
      } catch {
        transport.onerror?.(new Error('Invalid MCP stdio message'))
        continue
      }
      transport.onmessage?.(message)
    }
  }

  function onEnd(): void {
    if (closed) return
    if (buffer.length) transport.onerror?.(new Error('Incomplete MCP stdio message at end of input'))
    void transport.close()
  }

  function onStreamError(): void {
    if (closed) return
    transport.onerror?.(new Error('MCP stdio stream failed'))
    void transport.close()
  }
}
