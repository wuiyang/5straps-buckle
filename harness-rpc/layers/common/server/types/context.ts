import type { BuckleHttpServices } from '../../../../common/types/ports/mcp-http.js'

// Type-only: routes reach common services through event.context.services, never by import.
declare module '@5straps/runtime/nitro' {
  interface RuntimeServices extends BuckleHttpServices {}
}

export {}
