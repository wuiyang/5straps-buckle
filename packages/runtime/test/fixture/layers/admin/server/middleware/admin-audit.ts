import { defineMiddleware } from 'h3'

// Global like all scanned middleware, so it matches its own paths explicitly (F25).
export default defineMiddleware((event) => {
  if (event.url.pathname !== '/setup' && !event.url.pathname.startsWith('/setup/')) return
  event.context.logger?.info('admin request', { method: event.req.method, path: event.url.pathname })
})
