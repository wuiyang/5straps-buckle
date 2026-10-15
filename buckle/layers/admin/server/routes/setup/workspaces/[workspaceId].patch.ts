import { defineRegistryHandler, registryTarget } from '../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, views, audited, body }) => {
    const patch = views.workspacePatch((await body()) ?? null)
    const id = registryTarget(event, workspaces)
    return { workspace: await audited({ tool: 'workspace_update', workspaceId: id }, () => workspaces.update(id, patch)) }
  },
})
