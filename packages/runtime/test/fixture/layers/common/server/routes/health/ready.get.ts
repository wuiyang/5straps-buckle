import { defineHandler } from 'h3'
import { requireReady } from '@5straps/runtime/nitro'

export default defineHandler((event) => {
  requireReady(event)
  return { status: 'ready' }
})
