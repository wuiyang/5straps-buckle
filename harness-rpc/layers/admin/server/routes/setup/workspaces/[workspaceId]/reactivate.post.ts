import { getRouterParam } from 'h3'
import { withRegistryAudit } from '../../../../utils/audit.js'
import { defineRegistryHandler } from '../../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, actions }) => {
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    return { workspace: await withRegistryAudit(actions, { tool: 'workspace_reactivate', workspaceId: id }, () => workspaces.update(id, { retired: false })) }
  },
})
