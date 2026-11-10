import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NitroApp } from 'nitro/types'

export interface BuiltEntry {
  nitroApp: NitroApp
  middleware: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}
