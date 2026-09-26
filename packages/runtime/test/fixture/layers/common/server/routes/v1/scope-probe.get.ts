import { defineHandler } from 'h3'
import { useScopeSafe } from '@5straps/runtime'

// Reads the ALS scope main.ts opened around this request; only one shared runtime copy can see it.
export default defineHandler(() => ({ correlationId: useScopeSafe()?.context.correlationId ?? null }))
