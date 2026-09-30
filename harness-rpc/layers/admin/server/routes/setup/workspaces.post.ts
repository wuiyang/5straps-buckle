import { json } from '../../../../common/server/utils/respond.js'
import { defineRegistryHandler } from '../../utils/setup.js'

export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ workspaces, views, audited, body }) => {
    const registration = views.registration((await body()) ?? null)
    const workspace = await audited({ tool: 'workspace_register', workspaceId: registration.id }, () => workspaces.register(registration))
    return json({ workspace }, { status: 201 })
  },
})
