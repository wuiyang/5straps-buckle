import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { registerHttpServerClose, runInScope, type RequestCli } from '@5straps/runtime'
import { bindHost } from '@5straps/runtime/nitro'
import type { FixtureRuntime } from '../common/runtime.js'
import type { BuiltEntry } from './built-entry.js'
import { wireCliListener, type CliListenerMode } from './cli-listener.js'
import { pluginOrder } from './plugin-order.js'

// Close steps are registered on the runtime owner: stop accepting at 'accept', connections drained at 'streams'.
export interface ServerAdapter {
  listen(options: { port: number; host: string }): Promise<number>
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
  registerHttpServerClose({ server, owner: runtime.owner })
  server.on('upgrade', (request, socket, head) => {
    // Node drops its own socket error handler before 'upgrade'; a client that resets mid-reply must not crash the process.
    socket.on('error', (error) => {
      runtime.logger.debug('upgrade socket error', { error })
      socket.destroy()
    })
    entry.handleUpgrade(request, socket, head).catch((error: unknown) => {
      runtime.logger.error('websocket upgrade failed', { error })
      socket.destroy()
    })
  })
  return { listen: options => listen(server, options) }
}

// F-one-copy: a scope opened here in main must be visible inside the bundled route.
function withScopeProbe(input: { runtime: FixtureRuntime; middleware: BuiltEntry['middleware'] }) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== SCOPE_PROBE_PATH) return input.middleware(request, response)
    const scope = input.runtime.owner.registry.createScope({ context: { correlationId: `main-probe-${Date.now()}` } })
    input.runtime.logger.info('scope probe opened', { probeId: scope.context.correlationId, runtimeUrl: import.meta.resolve('@5straps/runtime') })
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
