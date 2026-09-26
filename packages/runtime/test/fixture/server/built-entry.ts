import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NitroApp } from 'nitro/types'

// Shape of the built server/entry.ts as main.ts imports it from .output/server/index.mjs.
export interface BuiltEntry {
  nitroApp: NitroApp
  middleware: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}
