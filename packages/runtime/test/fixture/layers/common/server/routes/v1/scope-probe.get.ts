import { defineHandler } from 'h3'
import { useScopeSafe } from '@5straps/runtime'

// Reads the ALS scope main.ts opened around this request, and names the runtime module the bundle loaded.
export default defineHandler(() => ({ correlationId: useScopeSafe()?.context.correlationId ?? null, runtimeUrl: import.meta.resolve('@5straps/runtime') }))
