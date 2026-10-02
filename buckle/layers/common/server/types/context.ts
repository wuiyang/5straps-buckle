import type { BuckleHttpServices } from '../../../../common/types/ports/mcp-http.js'

// Type-only: routes reach common services through event.context.services, never by import.
declare module '@5straps/runtime/nitro' {
  interface RuntimeServices extends BuckleHttpServices {}
}

declare module 'h3' {
  interface H3EventContext {
    /** The body as read once, up to the route's limit: a signed request's guard hashes the same bytes its handler parses. */
    requestBody?: Uint8Array<ArrayBuffer>
  }
}

export {}
