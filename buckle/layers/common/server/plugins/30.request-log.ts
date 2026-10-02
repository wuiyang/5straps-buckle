import { getEventContext, type H3EventContext } from 'h3'
import { definePlugin } from 'nitro'

/** Polled by supervisors: logged at debug, so a probe every few seconds does not flood the log. */
const PROBES: readonly string[] = Object.freeze(['/health', '/health/ready'])

/**
 * One structured line per request as its response goes out (B19), refused and unrouted requests
 * included: the method, the route pattern that answered (never the path a caller chose), the status,
 * the duration, a correlation id (the operation's, or one for this request when it had none) and who
 * the guard said the caller was. No path, query, body or credential. A streamed response is logged
 * when its headers go out; the runtime's own `request completed` line marks the end of its stream.
 */
export default definePlugin((nitroApp) => {
  const started = new WeakMap<object, { at: number; correlationId: string }>()
  nitroApp.hooks.hook('request', (event) => {
    started.set(event, { at: performance.now(), correlationId: crypto.randomUUID() })
  })
  nitroApp.hooks.hook('response', (response, event) => {
    const context = getEventContext<H3EventContext>(event)
    if (!context.logger) return
    const request = started.get(event)
    const route = context.matchedRoute?.route ?? null
    const operation = context.scope?.context
    const fields = {
      method: event.req.method,
      route,
      status: response.status,
      durationMs: request ? Math.round(performance.now() - request.at) : 0,
      correlationId: operation?.correlationId ?? request?.correlationId ?? null,
      ...(operation?.actor ? { actor: operation.actor } : {}),
      ...(operation?.workspaceId ? { workspaceId: operation.workspaceId } : {}),
      ...(operation?.clientRequestId ? { clientRequestId: operation.clientRequestId } : {}),
    }
    if (route !== null && PROBES.includes(route)) context.logger.debug('request finished', fields)
    else context.logger.info('request finished', fields)
  })
})
