import wsAdapter from 'crossws/adapters/node'
import type { Hooks } from 'crossws'
import { useNitroApp } from 'nitro/app'
import { toNodeHandler } from 'srvx/node'

type WebSocketHooks = Partial<Hooks>
const WEBSOCKET_HOOKS = Symbol.for('crossws.hooks')
type HookCarrier = { [WEBSOCKET_HOOKS]?: WebSocketHooks; context?: { [WEBSOCKET_HOOKS]?: WebSocketHooks } }

// Replaces the node_middleware preset entry: same middleware and handleUpgrade exports, plus the
// app itself so main.ts can bind the host and the cli:call listener before listening.
export const nitroApp = useNitroApp()
export const middleware = toNodeHandler(nitroApp.fetch)
export const handleUpgrade = wsAdapter({ resolve: resolveWebSocketHooks }).handleUpgrade

// Nitro's resolveWebsocketHooks returns {} when the route answers without hooks, and crossws then
// accepts the upgrade with no handlers. Fail closed: a refused or unmatched upgrade ends with the
// route's own response (401, 404, 503) instead of an open socket.
async function resolveWebSocketHooks(request: Request): Promise<WebSocketHooks> {
  const response = await nitroApp.fetch(request) as Response & { crossws?: WebSocketHooks }
  const carrier = request as Request & HookCarrier
  return response.crossws ?? carrier[WEBSOCKET_HOOKS] ?? carrier.context?.[WEBSOCKET_HOOKS] ?? { upgrade: () => response }
}
