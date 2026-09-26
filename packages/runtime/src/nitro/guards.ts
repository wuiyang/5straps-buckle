import { randomUUID } from 'node:crypto'
import { defineHandler, HTTPError, type EventHandlerRequest, type EventHandlerWithFetch, type H3Event } from 'h3'
import { isRuntimeError, RuntimeErrorCode } from '../errors.js'
import type { RuntimeOwner } from '../lifecycle/owner.js'
import { runInScope, type OperationContextInput, type OperationScope } from '../scope/als.js'

export type GuardResult = Omit<OperationContextInput, 'correlationId' | 'attributes'>
export type Guard = (event: H3Event) => void | GuardResult | Promise<void | GuardResult>

export interface GuardedHandlerDefinition<T> {
  guards: readonly Guard[]
  handler: (event: H3Event, scope: OperationScope) => T | Promise<T>
}

const REQUEST_ID = /^[\w.:-]{1,128}$/

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
    const scope = runtime.registry.createScope({ context: { ...identity, correlationId: requestCorrelationId(event) }, signal: event.req.signal })
    event.context.scope = scope
    return runRequestInScope({ event, scope, handler: definition.handler })
  })
}

async function runGuards(event: H3Event, guards: readonly Guard[]): Promise<GuardResult> {
  let identity: GuardResult = {}
  for (const guard of guards) identity = { ...identity, ...(await guard(event)) }
  return identity
}

function requestCorrelationId(event: H3Event): string {
  const supplied = event.req.headers.get('x-request-id')
  return supplied && REQUEST_ID.test(supplied) ? supplied : randomUUID()
}

// The scope lives until the response body finishes or is cancelled, not merely until the handler returns.
export async function runRequestInScope<T>(input: { event: H3Event; scope: OperationScope; handler: (event: H3Event, scope: OperationScope) => T | Promise<T> }): Promise<T | Response> {
  const { event, scope } = input
  const startedAt = performance.now()
  const finish = (outcome: string) => {
    event.context.logger?.info('request completed', { method: event.req.method, path: event.url.pathname, outcome, durationMs: Math.round(performance.now() - startedAt) })
    return scope.dispose().catch((error: unknown) => event.context.logger?.error('request scope failed to close', { error }))
  }
  let result: T
  try {
    result = await runInScope(scope, () => input.handler(event, scope))
  } catch (error) {
    await finish(HTTPError.isError(error) ? `error ${error.status}` : 'error')
    throw error
  }
  if (result instanceof Response && result.body) return ownResponseBody(result, () => { void finish(`streamed ${result.status}`) })
  await finish(result instanceof Response ? `ok ${result.status}` : 'ok')
  return result
}

function ownResponseBody(response: Response, onDone: () => void): Response {
  const reader = response.body!.getReader()
  let done = false
  const complete = () => { if (!done) { done = true; onDone() } }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          complete()
        } else controller.enqueue(chunk.value)
      } catch (error) {
        controller.error(error)
        complete()
      }
    },
    async cancel(reason) {
      complete()
      await reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
