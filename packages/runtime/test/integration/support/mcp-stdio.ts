import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Transport } from '@modelcontextprotocol/client'

export interface AuditedStdioTransport extends Transport {
  // Every raw stdout line, so a test can prove stdout carried only JSON-RPC frames (F18).
  readonly stdoutLines: string[]
}

// Client transport over a child we spawned ourselves (the SDK's stdio client spawns its own child).
export function createChildStdioTransport(child: ChildProcess): AuditedStdioTransport {
  const stdoutLines: string[] = []
  const transport: AuditedStdioTransport = {
    stdoutLines,
    async start() {
      createInterface({ input: child.stdout! }).on('line', (line) => {
        stdoutLines.push(line)
        try {
          transport.onmessage?.(JSON.parse(line))
        } catch (error) {
          transport.onerror?.(error as Error)
        }
      })
      child.once('close', () => transport.onclose?.())
    },
    async send(message) {
      child.stdin!.write(`${JSON.stringify(message)}\n`)
    },
    async close() {
      child.stdin!.end()
    },
  }
  return transport
}
