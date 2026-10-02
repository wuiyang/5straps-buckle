import { defineRegistryHandler } from '../../utils/setup.js'

// The registry without any credential: the node's own workspace first, then the registered ones.
export default defineRegistryHandler({
  access: 'inspection',
  handler: ({ workspaces }) => ({ workspaces: workspaces.list() }),
})
