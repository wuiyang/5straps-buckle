import { definePlugin } from 'nitro'
import { defineContextPlugin } from '@5straps/runtime/nitro'

// Sets the runtime, the service accessors, the logger and the host's one requester on each request
// from the host main.ts binds. It authorizes nothing: each handler runs its own guards. Routes ask
// nobody themselves: questions go through the approval service.
const attachContext = defineContextPlugin()

export default definePlugin((nitroApp) => {
  attachContext(nitroApp)
})
