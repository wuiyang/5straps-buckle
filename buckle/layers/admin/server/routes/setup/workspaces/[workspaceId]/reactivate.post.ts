import { defineRegistryHandler, registryTarget } from '../../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, audited }) => {
    const id = registryTarget(event, workspaces)
    return { workspace: await audited({ tool: 'workspace_reactivate', workspaceId: id }, () => workspaces.update(id, { online: true })) }
  },
})
