import { noContent } from '../../../../../common/server/utils/respond.js'
import { defineRegistryHandler, registryTarget } from '../../../utils/setup.js'

// Takes the workspace offline: its files, history and audit stay; reactivation is explicit.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, audited }) => {
    const id = registryTarget(event, workspaces)
    await audited({ tool: 'workspace_retire', workspaceId: id }, () => workspaces.update(id, { online: false }))
    return noContent()
  },
})
