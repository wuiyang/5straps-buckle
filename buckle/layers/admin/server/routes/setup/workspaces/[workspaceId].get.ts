import { notFound } from '../../../../../common/server/utils/errors.js'
import { defineRegistryHandler, registryTarget } from '../../../utils/setup.js'

// By id or by name (D85, Q15); the body carries the id.
export default defineRegistryHandler({
  access: 'inspection',
  handler: ({ event, workspaces }) => {
    const workspace = workspaces.lookup(registryTarget(event, workspaces))
    if (!workspace) throw notFound('Workspace not found')
    return { workspace }
  },
})
