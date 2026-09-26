import { definePlugin } from 'nitro'
import { recordPlugin } from '../../../../server/plugin-order.js'
import { activeFaults } from '../utils/faults.js'

// Test-only fault injection (F24): a request hook that throws before the context plugin runs.
export default definePlugin((nitroApp) => {
  recordPlugin(nitroApp, 'common:faults-before-context')
  if (!activeFaults().includes('hook-before-context')) return
  nitroApp.hooks.hook('request', () => { throw new Error('Injected request hook failure before context') })
})

