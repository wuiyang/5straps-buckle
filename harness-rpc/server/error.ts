import { getEventContext, HTTPError, type H3EventContext } from 'h3'
import { defineErrorHandler } from 'nitro'
import { runInScopeContext } from '@5straps/runtime'

const UNHANDLED = 'Internal Buckle error'

// Every error leaves as JSON {error}; internals stay in the server log.
export default defineErrorHandler((error, event) => {
  const handled = HTTPError.isError(error) && !error.unhandled
  const status = handled ? error.status : 500
  if (!handled) logFailure({ context: getEventContext<H3EventContext>(event), path: new URL(event.req.url).pathname, error })
  const headers = new Headers(handled ? error.headers : undefined)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({ error: publicMessage({ handled, status, error }) }), { status, headers })
})

// H3's own 404 message echoes the full request URL, host and port included.
function publicMessage(input: { handled: boolean; status: number; error: { message: string } }): string {
  if (!input.handled) return UNHANDLED
  return input.status === 404 ? 'Not Found' : input.error.message
}

// Inside the request scope when there is one, so the line carries the server correlation id.
function logFailure(input: { context: H3EventContext; path: string; error: unknown }): void {
  const log = () => input.context.logger?.error('Unhandled Buckle request error', { path: input.path, error: input.error })
  if (input.context.scope) runInScopeContext(input.context.scope, log)
  else log()
}
