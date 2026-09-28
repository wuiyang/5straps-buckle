import { getRouterParam } from 'h3'
import { noContent } from '../../../../../common/server/utils/respond.js'
import { withRegistryAudit } from '../../../utils/audit.js'
import { defineRegistryHandler } from '../../../utils/setup.js'

// Retires the workspace: its files, history and audit stay; reactivation is explicit.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, actions }) => {
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    await withRegistryAudit(actions, { tool: 'workspace_retire', workspaceId: id }, () => workspaces.update(id, { retired: true }))
    return noContent()
  },
})
