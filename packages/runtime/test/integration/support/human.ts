import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export interface PromptRequest {
  id: string
  kind: string
  correlationId: string
  actor?: string
  action: { summary: string }
  wait: { mode: 'finite'; timeoutMs: number } | { mode: 'indefinite' }
}

export type TerminalMessage = { type: 'prompt'; request: PromptRequest } | { type: 'withdrawn'; requestId: string; reason: string }

export interface Human {
  path: string
  messages: TerminalMessage[]
  connected: Promise<void>
  prompts(): PromptRequest[]
  waitFor(predicate: (message: TerminalMessage) => boolean, timeoutMs?: number): Promise<TerminalMessage>
  waitForPrompt(predicate?: (request: PromptRequest) => boolean): Promise<PromptRequest>
  answer(requestId: string, choice: string): void
  deny(requestId: string, reason?: string): void
  close(): Promise<void>
}

export async function startHuman(): Promise<Human> {
  const path = join(mkdtempSync(join(tmpdir(), 'human-')), 'terminal.sock')
  const messages: TerminalMessage[] = []
  const watchers = new Set<() => void>()
  const connection = Promise.withResolvers<Socket>()
  const server = createServer((socket) => {
    connection.resolve(socket)
    createInterface({ input: socket }).on('line', (line) => {
      messages.push(JSON.parse(line) as TerminalMessage)
      watchers.forEach(watch => watch())
    })
  })
  server.listen(path)
  await once(server, 'listening')
  const send = async (value: unknown) => { (await connection.promise).write(`${JSON.stringify(value)}\n`) }

  function waitFor(predicate: (message: TerminalMessage) => boolean, timeoutMs = 10_000): Promise<TerminalMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find(predicate)
        if (!found) return
        clearTimeout(timer)
        watchers.delete(check)
        resolve(found)
      }
      const timer = setTimeout(() => { watchers.delete(check); reject(new Error(`terminal message not seen; got ${JSON.stringify(messages)}`)) }, timeoutMs)
      watchers.add(check)
      check()
    })
  }

  return {
    path,
    messages,
    connected: connection.promise.then(() => undefined),
    prompts: () => messages.flatMap(message => (message.type === 'prompt' ? [message.request] : [])),
    waitFor,
    async waitForPrompt(predicate = () => true) {
      const message = await waitFor(item => item.type === 'prompt' && predicate(item.request))
      return (message as Extract<TerminalMessage, { type: 'prompt' }>).request
    },
    answer: (requestId, choice) => { void send({ type: 'answer', requestId, choice }) },
    deny: (requestId, reason) => { void send({ type: 'deny', requestId, ...(reason ? { reason } : {}) }) },
    async close() {
      const socket = await Promise.race([connection.promise, Promise.resolve(undefined)])
      socket?.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
