// F55: compiled in its own program so the augmentation must arrive through the /nitro entry import,
// addressed by the package specifier a backend uses.
import type { H3Event } from 'h3'
import type { NitroApp } from 'nitro/types'
import type { CliRequest } from '@5straps/runtime'
import { registerCliListener } from '@5straps/runtime/nitro'

declare module '@5straps/runtime/nitro' {
  interface RuntimeServices {
    getNotes(): string[]
  }
}

declare const app: NitroApp
declare const event: H3Event
declare const request: CliRequest

registerCliListener(app, async (item, respond) => { respond({ status: "denied", requestId: item.id }) })
// @ts-expect-error the interactive listener must be async
registerCliListener(app, (item, respond) => { respond({ status: 'denied', requestId: item.id }) })
// @ts-expect-error respond only accepts typed outcomes
registerCliListener(app, async (item, respond) => { respond({ status: 'approved', requestId: item.id }) })

void app.hooks?.callHook('cli:call', request, () => {})
// @ts-expect-error cli:call requires the respond callback
void app.hooks?.callHook('cli:call', request)
// @ts-expect-error unknown hook names stay rejected
void app.hooks?.callHook('cli:cal', request, () => {})

const notes: string[] | undefined = event.context.services?.getNotes()
// @ts-expect-error services only expose accessors the backend declared
event.context.services?.getMissing()
// @ts-expect-error requestCli is optional until the context plugin ran; handlers must check it
void event.context.requestCli(request)
const correlation: string | undefined = event.context.scope?.context.correlationId
const ready: void | undefined = event.context.runtime?.requireReady()
event.context.logger?.info('typed logger')

export { correlation, notes, ready }
