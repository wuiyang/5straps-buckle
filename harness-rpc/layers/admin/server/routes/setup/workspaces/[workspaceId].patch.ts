import { getRouterParam } from 'h3'
import { defineRegistryHandler } from '../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, views, audited, body }) => {
    const patch = views.workspacePatch((await body()) ?? null)
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    return { workspace: await audited({ tool: 'workspace_update', workspaceId: id }, () => workspaces.update(id, patch)) }
  },
})
