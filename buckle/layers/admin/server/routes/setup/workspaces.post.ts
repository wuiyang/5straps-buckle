import { json } from '../../../../common/server/utils/respond.js'
import { defineRegistryHandler } from '../../utils/setup.js'

// The agent token is returned once, and never cached on the way (review L9 of B15-B17); the registry keeps its digest alone.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ workspaces, views, audited, body }) => {
    const registration = views.registration((await body()) ?? null)
    const created = await audited({ tool: 'workspace_register', workspaceId: registration.id ?? 'unresolved' }, () => workspaces.create(registration))
    return json(created, { status: 201, headers: { 'cache-control': 'no-store' } })
  },
})
