import { useDatabase } from 'nitro/database'
import { rawConnection } from '@5straps/runtime/sqlite'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { requireAgent } from '../../../utils/guards.js'

// F39: where Nitro's useDatabase() actually opens, whatever the process was started with.
export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async () => ({ path: (await rawConnection(useDatabase())).location() }),
})
