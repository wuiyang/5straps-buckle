import { defineWebSocketHandler, type H3Event } from 'h3'
import type { Hooks, Peer } from 'crossws'
import { runInScope, useScope, type OperationScope } from '@5straps/runtime'

const AUTH_TIMEOUT_MS = 2_000
const CLOSE = Object.freeze({ unauthorized: 4401, authTimeout: 4408, shutdown: 1001 })

// F26: browsers cannot send an Authorization header on upgrade, so the first frame authenticates.
// The socket gets its own operation scope, owned until disconnect; the HTTP event is not kept.
export default defineWebSocketHandler(event => socketHooks(event))

function socketHooks(event: H3Event): Partial<Hooks> {
  const { runtime, services, logger } = event.context
  let scope: OperationScope | undefined
  let authTimer: NodeJS.Timeout | undefined
  let onShutdown: (() => void) | undefined

  const release = (reason: string) => {
    clearTimeout(authTimer)
    if (onShutdown) runtime?.signal.removeEventListener('abort', onShutdown)
    void scope?.dispose()
    logger?.info('websocket closed', { reason, correlationId: scope?.context.correlationId })
  }

  return {
    upgrade() {
      if (runtime?.state !== 'ready' || !services) return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
    },
    open(peer) {
      authTimer = setTimeout(() => peer.close(CLOSE.authTimeout, 'authentication timeout'), AUTH_TIMEOUT_MS)
      onShutdown = () => peer.close(CLOSE.shutdown, 'server shutting down')
      runtime?.signal.addEventListener('abort', onShutdown, { once: true })
    },
    async message(peer, message) {
      if (!runtime || !services) return peer.close(CLOSE.unauthorized, 'unavailable')
      if (!scope) {
        const actor = (await services.getAccess()).verify('agent', firstFrameToken(message.text()))
        if (!actor) return peer.close(CLOSE.unauthorized, 'unauthorized')
        clearTimeout(authTimer)
        scope = runtime.registry.createScope({ context: { actor } })
        return send(peer, { type: 'ready', actor })
      }
      const active = scope
      await runInScope(active, async () => {
        const serial = (await services.getOperation()).record('ws.message')
        send(peer, { type: 'whoami', actor: useScope().context.actor, correlationId: useScope().context.correlationId, serial })
      })
    },
    close(_peer, details) {
      release(`closed ${details.code ?? 'unknown'}`)
    },
  }
}

function firstFrameToken(text: string): string | undefined {
  try {
    const frame = JSON.parse(text) as { type?: unknown; token?: unknown }
    return frame.type === 'auth' && typeof frame.token === 'string' ? frame.token : undefined
  } catch {
    return undefined
  }
}

function send(peer: Peer, value: unknown): void {
  peer.send(JSON.stringify(value))
}
