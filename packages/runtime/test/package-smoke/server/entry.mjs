import { useNitroApp } from 'nitro/app'
import { toNodeHandler } from 'srvx/node'

export const nitroApp = useNitroApp()
export const middleware = toNodeHandler(nitroApp.fetch)
