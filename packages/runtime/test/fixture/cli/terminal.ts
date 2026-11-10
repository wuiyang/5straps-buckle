import { once } from 'node:events'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { CliConsumer, CliConsumerResult, CliRequest } from '@5straps/runtime'

// Lines the terminal sends to the person (the test) and the answers it accepts back.
export type TerminalOutput = { type: 'prompt'; request: CliRequest } | { type: 'withdrawn'; requestId: string; reason: string }
type TerminalInput = { type: 'answer'; requestId: string; choice: string } | { type: 'deny'; requestId: string; reason?: string }

export interface TerminalChannel {
  consumer: CliConsumer
  onDisconnect(listener: () => void): void
  close(): Promise<void>
}

// Scriptable fake terminal on a local socket. Prompts never touch stdout, which MCP stdio owns.
export async function connectTerminal(path: string): Promise<TerminalChannel> {
  const socket = createConnection(path)
  await once(socket, 'connect')
  const answers = new Map<string, (result: CliConsumerResult) => void>()
  const send = (output: TerminalOutput) => { if (socket.writable) socket.write(`${JSON.stringify(output)}\n`) }
  createInterface({ input: socket }).on('line', (line) => {
    const input = parseInput(line)
    if (input) answers.get(input.requestId)?.(input.type === 'answer' ? { status: 'answered', answer: { choice: input.choice } } : { status: 'denied', ...(input.reason ? { reason: input.reason } : {}) })
  })
  return {
    consumer: {
      prompt(request, { signal }) {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            answers.delete(request.id)
            send({ type: 'withdrawn', requestId: request.id, reason: String(signal.reason ?? 'aborted') })
            reject(signal.reason)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          answers.set(request.id, (result) => {
            answers.delete(request.id)
            signal.removeEventListener('abort', onAbort)
            resolve(result)
          })
          send({ type: 'prompt', request })
        })
      },
    },
    onDisconnect: listener => socket.once('close', listener),
    close: () => new Promise(resolve => socket.end(resolve)),
  }
}

function parseInput(line: string): TerminalInput | undefined {
  try {
    const value = JSON.parse(line) as Partial<TerminalInput>
    if (typeof value.requestId !== 'string') return undefined
    if (value.type === 'answer' && typeof value.choice === 'string') return value as TerminalInput
    if (value.type === 'deny') return value as TerminalInput
  } catch {}
  return undefined
}
