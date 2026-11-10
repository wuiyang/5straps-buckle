import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { NitroApp } from 'nitro/types'

export interface BuiltEntry {
  nitroApp: NitroApp
  middleware: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
}
