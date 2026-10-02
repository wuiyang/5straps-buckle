import { useNitroApp } from 'nitro/app'
import { toNodeHandler } from 'srvx/node'

// Replaces the node_middleware preset entry: the same middleware, plus the app itself, so main.ts
// binds the host and the one cli:call listener before listening. No WebSocket: Node answers an
// upgrade request as a plain request while the server has no 'upgrade' listener.
export const nitroApp = useNitroApp()
export const middleware = toNodeHandler(nitroApp.fetch)
