import { json } from '../../../../common/server/utils/respond.js'
import { defineRegistryHandler } from '../../utils/setup.js'

// The agent token is returned once, and never cached on the way (review L9 of B15-B17); the registry keeps its digest alone.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ workspaces, views, audited, body }) => {
    const registration = views.registration((await body()) ?? null)
    // The attempt knows the name asked for and no id; the result names the id the registry assigned, and the name it holds.
    const asked = registration.name ?? registration.id
    const created = await audited({ tool: 'workspace_register', workspaceId: 'unresolved', ...(asked === undefined ? {} : { workspaceName: asked }), named: result => ({ workspaceId: result.workspace.id, workspaceName: result.workspace.name }) }, () => workspaces.create(registration))
    return json(created, { status: 201, headers: { 'cache-control': 'no-store' } })
  },
})
