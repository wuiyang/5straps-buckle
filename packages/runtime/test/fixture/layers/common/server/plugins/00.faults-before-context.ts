import { definePlugin } from 'nitro'
import { useHost } from '@5straps/runtime/nitro'
import { recordPlugin } from '../../../../server/plugin-order.js'
import { activeFaults } from '../utils/faults.js'

// Test-only fault injection (F24): a request hook that throws before the context plugin runs.
export default definePlugin((nitroApp) => {
  recordPlugin(nitroApp, 'common:faults-before-context')
  const active = activeFaults()
  if (active.length === 0) return
  // Evidence that each injected failure really fired: Nitro captures it and calls the error hook.
  nitroApp.hooks.hook('error', (error, context) => {
    useHost(nitroApp)?.logger.warn('captured hook error', { tags: context.tags?.join(',') ?? '', message: error.message })
  })
  if (active.includes('hook-before-context')) nitroApp.hooks.hook('request', () => { throw new Error('Injected request hook failure before context') })
})
