import { getEventContext, HTTPError, type H3EventContext } from 'h3'
import { defineErrorHandler } from 'nitro'

// Every error leaves as JSON {error}; internals stay in the server log.
export default defineErrorHandler((error, event) => {
  const handled = HTTPError.isError(error) && !error.unhandled
  const status = handled ? error.status : 500
  if (!handled) getEventContext<H3EventContext>(event).logger?.error('request failed', { path: new URL(event.req.url).pathname, error })
  const headers = new Headers(handled ? error.headers : undefined)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({ error: handled ? error.message : 'Internal server error' }), { status, headers })
})
