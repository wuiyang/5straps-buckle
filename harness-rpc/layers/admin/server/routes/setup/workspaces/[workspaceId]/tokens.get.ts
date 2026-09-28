import { getRouterParam } from 'h3'
import { defineRegistryHandler } from '../../../../utils/setup.js'

// `BUCKLE-D12`: the agent tokens of a workspace by id and label, never their secrets.
export default defineRegistryHandler({
  access: 'inspection',
  handler: ({ event, workspaces }) => ({ tokens: workspaces.listTokens(getRouterParam(event, 'workspaceId', { decode: true }) ?? '') }),
})
