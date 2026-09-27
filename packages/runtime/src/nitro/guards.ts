import { randomUUID } from 'node:crypto'
import { defineHandler, HTTPError, type EventHandlerRequest, type EventHandlerWithFetch, type H3Event } from 'h3'
import { isRuntimeError, RuntimeError, RuntimeErrorCode } from '../errors.js'
import type { RuntimeOwner } from '../lifecycle/owner.js'
import { runInScope, runInScopeContext, type OperationContextInput, type OperationScope } from '../scope/als.js'
import { isScopeUsable } from '../scope/operation-scope.js'
import { NitroErrorCode } from './host.js'

export type GuardResult = Omit<OperationContextInput, 'correlationId' | 'attributes' | 'clientRequestId'>
export type Guard = (event: H3Event) => void | GuardResult | Promise<void | GuardResult>

export interface GuardedHandlerDefinition<T> {
  guards: readonly Guard[]
  handler: (event: H3Event, scope: OperationScope) => T | Promise<T>
  // Disposes the scope when a streamed body goes unread this long (default DEFAULT_BODY_IDLE_TIMEOUT_MS).
  bodyIdleTimeoutMs?: number
  // Overrides the runtime's drain bound for this route's background work.
  drainTimeoutMs?: number
}

const REQUEST_ID = /^[\w.:-]{1,128}$/
export const DEFAULT_BODY_IDLE_TIMEOUT_MS = 30_000

// Fails closed: no runtime in context (hook failed or host not bound) and not-ready both refuse with 503.
export const requireReady: Guard = (event) => {
  const runtime = event.context.runtime
  if (!runtime) throw HTTPError.status(503, 'Service Unavailable', { message: 'Runtime is not attached to this request' })
  try {
    runtime.requireReady()
  } catch (error) {
    if (isRuntimeError(error, RuntimeErrorCode.notReady)) throw HTTPError.status(503, 'Service Unavailable', { message: error.message })
    throw error
  }
}

// Guards run inside the handler itself, after any hooks or middleware, so a failed hook cannot skip them.
export function defineGuardedHandler<T>(definition: GuardedHandlerDefinition<T>): EventHandlerWithFetch<EventHandlerRequest, Promise<T | Response>> {
  return defineHandler(async (event) => {
    const identity = await runGuards(event, [requireReady, ...definition.guards])
    const runtime = event.context.runtime as RuntimeOwner
    const clientRequestId = suppliedRequestId(event)
    const context = { ...identity, correlationId: randomUUID(), ...(clientRequestId ? { clientRequestId } : {}) }
    const scope = runtime.registry.createScope({ context, signal: event.req.signal, ...(definition.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: definition.drainTimeoutMs }) })
    event.context.scope = scope
    return runRequestInScope({ event, scope, handler: definition.handler, bodyIdleTimeoutMs: definition.bodyIdleTimeoutMs })
  })
}

// Guards add identity; none may replace a field an earlier guard set (an auth guard's actor stays the actor).
export async function runGuards(event: H3Event, guards: readonly Guard[]): Promise<GuardResult> {
  const identity: Record<string, unknown> = {}
  for (const guard of guards) {
    for (const [field, value] of Object.entries((await guard(event)) ?? {})) {
      if (identity[field] !== undefined && identity[field] !== value) throw new RuntimeError(NitroErrorCode.identityOverwrite, `A later guard tried to replace ${field} set by an earlier guard`)
      identity[field] = value
    }
  }
  return identity as GuardResult
}

// Client-chosen, so concurrent requests may share it; kept apart from the server-issued correlation id.
function suppliedRequestId(event: H3Event): string | undefined {
  const supplied = event.req.headers.get('x-request-id')
  return supplied && REQUEST_ID.test(supplied) ? supplied : undefined
}

// The scope lives until the response body finishes or is cancelled, not merely until the handler returns.
async function runRequestInScope<T>(input: { event: H3Event; scope: OperationScope; handler: (event: H3Event, scope: OperationScope) => T | Promise<T>; bodyIdleTimeoutMs?: number }): Promise<T | Response> {
  const { event, scope } = input
  const idleTimeoutMs = input.bodyIdleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS
  const startedAt = performance.now()
  const clientRequestId = scope.context.clientRequestId
  const logger = event.context.logger
  // Logged in the scope's context, so the line carries the server correlation id next to the caller's request id.
  const finish = (outcome: string) => {
    runInScopeContext(scope, () => logger?.info('request completed', { method: event.req.method, path: event.url.pathname, outcome, durationMs: Math.round(performance.now() - startedAt), ...(clientRequestId ? { clientRequestId } : {}) }))
    return scope.dispose().catch((error: unknown) => runInScopeContext(scope, () => logger?.error('request scope failed to close', { error })))
  }
  // Respond first: disposal (bounded by the scope's drainTimeoutMs) runs after the response, so hung background work cannot hold it.
  let result: T
  try {
    result = await runInScope(scope, () => input.handler(event, scope))
  } catch (error) {
    void finish(HTTPError.isError(error) ? `error ${error.status}` : 'error')
    throw error
  }
  if (result instanceof Response && result.body) {
    const body = ownStream({ source: result.body, scope, idleTimeoutMs, onDone: () => { void finish(`streamed ${result.status}`) } })
    return new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers })
  }
  // The wrapper is a ReadableStream of the same chunks, so it stands in for the handler's T.
  if (result instanceof ReadableStream) return ownStream({ source: result, scope, idleTimeoutMs, onDone: () => { void finish('streamed') } }) as T
  void finish(result instanceof Response ? `ok ${result.status}` : 'ok')
  return result
}

// The scope ends when the body ends, errors, is cancelled, or sits unread for idleTimeoutMs. highWaterMark 0
// pulls only for a waiting reader, so the idle timer runs exactly while nobody reads; the source is read
// inside the scope, so pull-driven sources (async generators) see the request context.
function ownStream<C>(input: { source: ReadableStream<C>; scope: OperationScope; idleTimeoutMs: number; onDone: () => void }): ReadableStream<C> {
  const reader = input.source.getReader()
  let done = false
  let idleTimer: NodeJS.Timeout | undefined
  const complete = () => {
    clearTimeout(idleTimer)
    if (!done) { done = true; input.onDone() }
  }
  let stream: ReadableStreamDefaultController<C> | undefined
  const armIdleTimer = () => {
    idleTimer = setTimeout(() => {
      const reason = new Error(`Response body unread for ${input.idleTimeoutMs} ms`)
      stream?.error(reason)
      void reader.cancel(reason).catch(() => undefined)
      complete()
    }, input.idleTimeoutMs).unref()
  }
  const readSource = () => (isScopeUsable(input.scope) ? runInScope(input.scope, () => reader.read()) : reader.read())
  return new ReadableStream<C>({
    start(controller) {
      stream = controller
      armIdleTimer()
    },
    async pull(controller) {
      clearTimeout(idleTimer)
      try {
        const chunk = await readSource()
        if (chunk.done) {
          controller.close()
          complete()
        } else {
          controller.enqueue(chunk.value)
          if (!done) armIdleTimer()
        }
      } catch (error) {
        controller.error(error)
        complete()
      }
    },
    async cancel(reason) {
      complete()
      await reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}
