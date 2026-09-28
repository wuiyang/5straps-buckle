import type { BuckleServices } from '../../../../common/runtime/services.js'

// Type-only: routes reach common services through event.context.services, never by import.
declare module '@5straps/runtime/nitro' {
  interface RuntimeServices extends BuckleServices {}
}

export {}
