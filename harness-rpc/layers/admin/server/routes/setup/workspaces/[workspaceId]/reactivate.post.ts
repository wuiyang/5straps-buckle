import { getRouterParam } from 'h3'
import { defineRegistryHandler } from '../../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, audited }) => {
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    return { workspace: await audited({ tool: 'workspace_reactivate', workspaceId: id }, () => workspaces.update(id, { retired: false })) }
  },
})
