import type { Server } from 'node:http'
import type { RuntimeOwner } from './owner.js'

export interface HttpServerCloseOptions {
  server: Server
  owner: Pick<RuntimeOwner, 'onClose'>
  // Close step name; the connection drain step is named `${name} connections`.
  name?: string
}

// 'accept' only stops listening: an in-flight request may be waiting on the CLI, which the later 'waiters'
// stage settles, so waiting for requests there deadlocks until the step bound. 'streams' then waits for
// every connection to end; if that step is abandoned, the connections left are destroyed.
export function registerHttpServerClose(options: HttpServerCloseOptions): void {
  const { server, owner } = options
  const name = options.name ?? 'http server'
  let closed: Promise<void> = Promise.resolve()
  closeIdleAfterEachResponse(server)
  owner.onClose('accept', name, () => {
    if (!server.listening) return
    closed = new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    closed.catch(() => undefined)
    server.closeIdleConnections()
  })
  owner.onClose('streams', `${name} connections`, (signal) => {
    signal?.addEventListener('abort', () => server.closeAllConnections(), { once: true })
    return closed
  })
}

// Once listening stops, a keep-alive connection closes as soon as its response ends, not at the keep-alive timeout.
function closeIdleAfterEachResponse(server: Server): void {
  server.on('request', (_request, response) => response.once('close', () => {
    if (!server.listening) setImmediate(() => server.closeIdleConnections())
  }))
}
