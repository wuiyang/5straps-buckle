import { definePlugin } from 'nitro'
import { defineContextPlugin } from '@5straps/runtime/nitro'
import { recordPlugin } from '../../../../server/plugin-order.js'

const attachContext = defineContextPlugin()

export default definePlugin((nitroApp) => {
  recordPlugin(nitroApp, 'common:context')
  attachContext(nitroApp)
})
