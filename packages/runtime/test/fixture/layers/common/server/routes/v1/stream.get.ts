import { getQuery } from 'h3'
import { useScope } from '@5straps/runtime'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { requireAgent, useServices } from '../../utils/guards.js'

const INTERVAL_MS = 50
const MAX_EVENTS = 100
const encoder = new TextEncoder()

// F23: an SSE body that outlives the handler. Each event reports the scope state it runs in, and
// the source stops on completion, client cancel or runtime shutdown.
export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event) => {
    const runtime = event.context.runtime!
    const logger = event.context.logger
    ;(await useServices(event).getOperation()).record('stream')
    const total = Math.min(Number(getQuery(event).events ?? 5) || 5, MAX_EVENTS)
    let timer: NodeJS.Timeout | undefined
    let onShutdown: (() => void) | undefined
    let stopped = false
    const stop = (reason: string) => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      if (onShutdown) runtime.signal.removeEventListener('abort', onShutdown)
      logger?.info('stream ended', { reason })
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let sent = 0
        onShutdown = () => { stop('shutdown'); controller.close() }
        runtime.signal.addEventListener('abort', onShutdown, { once: true })
        timer = setInterval(() => {
          sent += 1
          const { state, context } = useScope()
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sent, scopeState: state, correlationId: context.correlationId })}\n\n`))
          if (sent < total) return
          stop('complete')
          controller.close()
        }, INTERVAL_MS)
      },
      cancel() { stop('cancelled') },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  },
})
