import { randomUUID } from 'node:crypto'
import type { ServeStdioOptions } from '@modelcontextprotocol/server/stdio'
import { logger } from '../common/runtime/logger.js'
import type { ActionLog, ActionLogEntry } from '../common/types/ports/action-log.js'

type Transport = NonNullable<ServeStdioOptions['transport']>
type Message = Parameters<Transport['send']>[0]
type Pending = { entry: ActionLogEntry; started: number }
const MAX_PENDING_REQUESTS = 256
const KNOWN_METHODS = new Set(['initialize', 'ping', 'tools/call', 'tools/list', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get', 'subscriptions/listen'])

/** Records the wire boundary before SDK dispatch; semantic execution remains the runtime's audit. */
export function createAuditedStdioTransport(input: {
  transport: Transport
  actions: ActionLog
  workspaceId: string
  isKnownTool: (name: string) => boolean
}): Transport {
  const pending = new Map<string | number, Pending>()
  let closing = false
  let closed = false
  let failed = false
  const transport: Transport = {
    start: async () => { if (closed || closing || failed) throw new Error('MCP stdio transport is closed'); await input.transport.start() },
    close: async () => { closing = true; await input.transport.close() },
    async send(message, options) {
      if (closed || closing || failed) throw new Error('MCP stdio transport is closed')
      if (!('method' in message) && 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number')) {
        const attempt = pending.get(message.id)
        if (attempt) {
          try {
            const result = 'result' in message ? message.result : undefined
            const isError = 'error' in message || (isRecord(result) && result['isError'] === true)
            finish(attempt, isError ? 'error' : 'ok', 'MCP response prepared; protocol status only')
            pending.delete(message.id)
          } catch {
            failClosed()
            throw new Error('MCP response withheld because audit persistence failed')
          }
        }
      }
      await input.transport.send(message, options)
    },
  }

  input.transport.onmessage = (message, extra) => {
    if (closed || closing || failed) return
    if (!('method' in message)) { transport.onmessage?.(message, extra); return }
    // Notifications have no response to correlate. A tools/call without an ID is still an attempt.
    if (!('id' in message)) {
      if (message.method === 'tools/call') {
        try { finish(begin(message), 'denied', 'Tool request missing an RPC identifier; not dispatched') }
        catch { failClosed() }
        return
      }
      transport.onmessage?.(message, extra)
      return
    }
    try {
      const attempt = begin(message)
      if ((typeof message.id === 'string' && message.id.length > 200) || pending.has(message.id) || pending.size >= MAX_PENDING_REQUESTS) {
        finish(attempt, 'denied', 'Invalid or duplicate RPC identifier, or pending request limit reached; not dispatched')
        void transport.close().catch(() => failClosed())
        return
      }
      pending.set(message.id, attempt)
      transport.onmessage?.(message, extra)
    } catch { failClosed() }
  }

  input.transport.onerror = () => {
    if (closed || closing || failed) return
    try {
      finish(begin(), 'error', 'MCP framing, parsing, or stream error; no request payload retained')
      transport.onerror?.(new Error('MCP stdio transport error'))
    } catch { failClosed() }
  }

  input.transport.onclose = () => {
    if (closed) return
    closed = true
    for (const attempt of pending.values()) {
      try { finish(attempt, 'interrupted', 'MCP connection closed before a response; execution effects unknown') }
      catch { reportAuditFailure() }
    }
    pending.clear()
    transport.onclose?.()
  }
  return transport

  function begin(message?: Extract<Message, { method: string }>): Pending {
    const auditId = randomUUID()
    const method = message?.method
    const params = message && 'params' in message ? message.params : undefined
    const name = isRecord(params) ? params['name'] : undefined
    const entry: ActionLogEntry = {
      auditId, requestId: auditId, workspaceId: input.workspaceId, sessionId: 'mcp-stdio-transport',
      at: new Date().toISOString(), tool: method === 'tools/call' ? 'mcp_stdio_tools_call' : method ? 'mcp_stdio_request' : 'mcp_stdio_transport_error',
      event: 'attempt', outcome: 'started', durationMs: 0, effects: [],
      args: { method: method && KNOWN_METHODS.has(method) ? method : 'unknown', ...(method === 'tools/call' ? { tool: typeof name === 'string' && input.isKnownTool(name) ? name : 'unknown' } : {}) },
    }
    input.actions.record(entry)
    return { entry, started: performance.now() }
  }

  function finish(attempt: Pending, outcome: ActionLogEntry['outcome'], detail: string): void {
    input.actions.record({ ...attempt.entry, at: new Date().toISOString(), event: 'result', outcome, durationMs: Math.round(performance.now() - attempt.started), detail })
  }

  function reportAuditFailure(): void {
    failed = true
    logger.error('MCP stdio audit persistence failed; connection closed')
  }

  function failClosed(): void {
    if (failed) return
    reportAuditFailure()
    void input.transport.close().catch(() => { closed = true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
