import { definePlugin } from 'nitro'
import { recordPlugin } from '../../../../server/plugin-order.js'
import { activeFaults } from '../utils/faults.js'

// Test-only fault injection (F24): request hooks that fail after context is set, sync and async.
export default definePlugin((nitroApp) => {
  recordPlugin(nitroApp, 'common:faults-after-context')
  const active = activeFaults()
  if (active.includes('hook-after-context')) nitroApp.hooks.hook('request', () => { throw new Error('Injected request hook failure after context') })
  if (active.includes('hook-async')) nitroApp.hooks.hook('request', async () => { throw new Error('Injected async request hook failure') })
})
