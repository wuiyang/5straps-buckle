import { definePlugin } from 'nitro'
import { defineContextPlugin } from '@5straps/runtime/nitro'

// Sets the runtime, the service accessors, the logger and requestCli on each request from the host
// main.ts binds. It authorizes nothing: each handler runs its own guards.
const attachContext = defineContextPlugin()

export default definePlugin((nitroApp) => {
  attachContext(nitroApp)
})
