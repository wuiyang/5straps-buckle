import { useNitroApp } from 'nitro/app'
import { toNodeHandler } from 'srvx/node'

// Replaces the node_middleware preset entry: same middleware export, plus the app itself for main.ts.
export const nitroApp = useNitroApp()
export const middleware = toNodeHandler(nitroApp.fetch)
