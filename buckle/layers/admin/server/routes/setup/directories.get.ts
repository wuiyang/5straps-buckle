import { defineRegistryHandler } from '../../utils/setup.js'

// Host directories under the owner's authority, each marked whether it can become a workspace root.
export default defineRegistryHandler({
  access: 'inspection',
  handler: ({ workspaces, views, query }) => views.directories(workspaces, query()),
})
