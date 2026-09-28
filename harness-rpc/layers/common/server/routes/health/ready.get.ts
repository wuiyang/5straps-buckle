import { defineHandler } from 'h3'
import { requireReady } from '@5straps/runtime/nitro'

// Readiness: 503 while the common runtime starts, after a failed start and once it closes.
export default defineHandler((event) => {
  requireReady(event)
  return { status: 'ready' }
})
