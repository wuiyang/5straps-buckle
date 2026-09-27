import { defineWebSocketHandler, type H3Event } from 'h3'
import type { Hooks, Peer } from 'crossws'
import { runInScope, useScope, type OperationScope } from '@5straps/runtime'

const AUTH_TIMEOUT_MS = 2_000
const CLOSE = Object.freeze({ unauthorized: 4401, authTimeout: 4408, shutdown: 1001, serverError: 1011 })

// awaiting-auth -> authenticating (first frame being verified) -> ready | closed
type Phase = 'awaiting-auth' | 'authenticating' | 'ready' | 'closed'

// F26: browsers cannot send an Authorization header on upgrade, so the first frame authenticates.
// The socket gets its own operation scope, owned until disconnect; the HTTP event is not kept.
export default defineWebSocketHandler(event => socketHooks(event))

function socketHooks(event: H3Event): Partial<Hooks> {
  const { runtime, services, logger } = event.context
  let phase: Phase = 'awaiting-auth'
  // Read through a function: close() can change the phase while authenticate() awaits.
  const currentPhase = (): Phase => phase
  let authenticating: Promise<void> | undefined
  let scope: OperationScope | undefined
  let authTimer: NodeJS.Timeout | undefined
  let onShutdown: (() => void) | undefined

  const release = (reason: string) => {
    phase = 'closed'
    clearTimeout(authTimer)
    if (onShutdown) runtime?.signal.removeEventListener('abort', onShutdown)
    const correlationId = scope?.context.correlationId
    scope?.dispose().then(
      () => logger?.info('websocket scope released', { correlationId }),
      (error: unknown) => logger?.error('websocket scope failed to close', { correlationId, error }),
    )
    logger?.info('websocket closed', { reason, correlationId })
  }

  // Only the first frame authenticates; the scope is created once, and never after the peer left.
  async function authenticate(peer: Peer, text: string): Promise<void> {
    phase = 'authenticating'
    try {
      const actor = (await services!.getAccess()).verify('agent', authToken(text))
      if (currentPhase() === 'closed') return
      if (!actor) {
        phase = 'closed'
        return peer.close(CLOSE.unauthorized, 'unauthorized')
      }
      clearTimeout(authTimer)
      scope = runtime!.registry.createScope({ context: { actor } })
      phase = 'ready'
      logger?.info('websocket authenticated', { correlationId: scope.context.correlationId })
      send(peer, { type: 'ready', actor })
    } catch (error) {
      logger?.warn('websocket authentication failed', { error })
      phase = 'closed'
      peer.close(CLOSE.serverError, 'authentication unavailable')
    }
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
      const text = message.text()
      if (phase === 'awaiting-auth') {
        authenticating = authenticate(peer, text)
        return authenticating
      }
      // crossws calls this hook once per frame without waiting; frames behind the first wait for its verdict, in order.
      if (phase === 'authenticating') await authenticating
      const active = scope
      if (currentPhase() !== 'ready' || !active) return
      if (authToken(text) !== undefined) return send(peer, { type: 'error', error: 'already authenticated' })
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

function authToken(text: string): string | undefined {
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
