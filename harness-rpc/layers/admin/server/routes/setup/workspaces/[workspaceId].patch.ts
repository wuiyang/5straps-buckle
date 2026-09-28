import { getRouterParam } from 'h3'
import { withRegistryAudit } from '../../../utils/audit.js'
import { defineRegistryHandler } from '../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, views, actions, body }) => {
    const patch = views.workspacePatch((await body()) ?? null)
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    return { workspace: await withRegistryAudit(actions, { tool: 'workspace_update', workspaceId: id }, () => workspaces.update(id, patch)) }
  },
})
