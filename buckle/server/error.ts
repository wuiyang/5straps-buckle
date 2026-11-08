import { getEventContext, HTTPError, type H3EventContext } from 'h3'
import { defineErrorHandler } from 'nitro'
import { runInScopeContext } from '@5straps/runtime'

const UNHANDLED = 'Internal Buckle error'

// Every error leaves as JSON {error}, with {code} and {saveError} where a route named them; internals stay in the server log.
export default defineErrorHandler((error, event) => {
  const handled = HTTPError.isError(error) && !error.unhandled
  const status = handled ? error.status : 500
  if (!handled) logFailure({ context: getEventContext<H3EventContext>(event), path: new URL(event.req.url).pathname, error })
  const headers = new Headers(handled ? error.headers : undefined)
  headers.set('content-type', 'application/json; charset=utf-8')
  const named = handled ? { code: error.body?.code, saveError: error.body?.saveError } : {}
  const fields = Object.fromEntries(Object.entries(named).filter(([, value]) => typeof value === 'string'))
  return new Response(JSON.stringify({ error: publicMessage({ handled, status, error: error as { message: string; statusText?: string } }), ...fields }), { status, headers })
})

// The router's own 404 message echoes the full request URL, host and port included, and it is the one
// 404 without a status text: Buckle's routes raise theirs with one (layers/common/server/utils/errors.ts).
function publicMessage(input: { handled: boolean; status: number; error: { message: string; statusText?: string } }): string {
  if (!input.handled) return UNHANDLED
  return input.status === 404 && !input.error.statusText ? 'Not Found' : input.error.message
}

// Inside the request scope when there is one, so the line carries the server correlation id.
function logFailure(input: { context: H3EventContext; path: string; error: unknown }): void {
  const log = () => input.context.logger?.error('Unhandled Buckle request error', { path: input.path, error: input.error })
  if (input.context.scope) runInScopeContext(input.context.scope, log)
  else log()
}
