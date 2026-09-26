import { defineHandler } from 'h3'

// Liveness only: no guard, no services, answers even while starting or after a hook failure.
export default defineHandler(() => ({ status: 'ok' }))
