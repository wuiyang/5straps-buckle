import { json } from '../../../../common/server/utils/respond.js'
import { withRegistryAudit } from '../../utils/audit.js'
import { defineRegistryHandler } from '../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ workspaces, views, actions, body }) => {
    const registration = views.registration((await body()) ?? null)
    const workspace = await withRegistryAudit(actions, { tool: 'workspace_register', workspaceId: registration.id }, () => workspaces.register(registration))
    return json({ workspace }, { status: 201 })
  },
})
