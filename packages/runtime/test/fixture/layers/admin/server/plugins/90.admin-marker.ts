import { definePlugin } from 'nitro'
import { recordPlugin } from '../../../../server/plugin-order.js'

export default definePlugin((nitroApp) => {
  recordPlugin(nitroApp, 'admin:marker')
})
