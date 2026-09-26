import { getEventContext, type H3EventContext } from 'h3'
import type { NitroAppPlugin } from 'nitro/types'
import { useHost } from './host.js'
import { createRequestCli } from './request-cli.js'

// Sets request context only. It authorizes nothing: guards in the handler must still run.
// The host is read per request because plugins run before main.ts binds it.
export function defineContextPlugin(): NitroAppPlugin {
  return (nitroApp) => {
    const requestCli = createRequestCli(nitroApp)
    nitroApp.hooks.hook('request', (event) => {
      const host = useHost(nitroApp)
      if (!host) return
      const context = getEventContext<H3EventContext>(event)
      context.runtime = host.owner
      context.services = host.services
      context.logger = host.logger
      context.requestCli = requestCli
    })
  }
}
