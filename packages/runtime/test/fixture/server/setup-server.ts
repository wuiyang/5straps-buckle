import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { runInScope, type RequestCli } from '@5straps/runtime'
import { bindHost } from '@5straps/runtime/nitro'
import type { FixtureRuntime } from '../common/runtime.js'
import type { BuiltEntry } from './built-entry.js'
import { wireCliListener, type CliListenerMode } from './cli-listener.js'
import { pluginOrder } from './plugin-order.js'

export interface ServerAdapter {
  listen(options: { port: number; host: string }): Promise<number>
  close(): Promise<void>
}

const SCOPE_PROBE_PATH = '/v1/scope-probe'

// Inactive until listen(): imports the built app, binds the host and the one cli:call listener first (F05).
export async function setupServer(input: { runtime: FixtureRuntime; requestCli: RequestCli; entryPath: string; listenerMode: CliListenerMode }): Promise<ServerAdapter> {
  const { runtime } = input
  const entry = await import(pathToFileURL(input.entryPath).href) as BuiltEntry
  runtime.logger.info('nitro plugins registered', { order: [...pluginOrder(entry.nitroApp)] })
  bindHost(entry.nitroApp, { owner: runtime.owner, services: runtime.services, logger: runtime.logger })
  runtime.logger.info('host bound')
  wireCliListener({ nitroApp: entry.nitroApp, requestCli: input.requestCli, mode: input.listenerMode })
  runtime.logger.info('cli listener registered', { mode: input.listenerMode })
  const server = createServer(withScopeProbe({ runtime, middleware: entry.middleware }))
  closeIdleAfterEachResponse(server)
  server.on('upgrade', (request, socket, head) => {
    entry.handleUpgrade(request, socket, head).catch((error: unknown) => {
      runtime.logger.error('websocket upgrade failed', { error })
      socket.destroy()
    })
  })
  return {
    listen: options => listen(server, options),
    close: () => closeServer(server),
  }
}

// F-one-copy: a scope opened here in main must be visible inside the bundled route.
function withScopeProbe(input: { runtime: FixtureRuntime; middleware: BuiltEntry['middleware'] }) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== SCOPE_PROBE_PATH) return input.middleware(request, response)
    const scope = input.runtime.owner.registry.createScope({ context: { correlationId: `main-probe-${Date.now()}` } })
    input.runtime.logger.info('scope probe opened', { probeId: scope.context.correlationId })
    response.once('close', () => { void scope.dispose() })
    return runInScope(scope, () => input.middleware(request, response))
  }
}

function listen(server: ReturnType<typeof createServer>, options: { port: number; host: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

// Stops accepting, then drops each keep-alive connection as soon as its in-flight response ends,
// so a stream ended by shutdown does not hold close open until the keep-alive timeout.
function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
    server.closeIdleConnections()
  })
}

function closeIdleAfterEachResponse(server: ReturnType<typeof createServer>): void {
  server.on('request', (_request, response) => response.once('close', () => {
    if (!server.listening) setImmediate(() => server.closeIdleConnections())
  }))
}
