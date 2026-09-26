import { defineGuardedHandler } from '@5straps/runtime/nitro'

// Exercises the installed runtime's Nitro entry (and its h3 import) through the built app.
export default defineGuardedHandler({ guards: [], handler: (_event, scope) => ({ status: 'ready', scoped: scope.state === 'active' }) })
