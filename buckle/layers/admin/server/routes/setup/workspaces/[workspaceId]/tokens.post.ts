import { json } from '../../../../../../common/server/utils/respond.js'
import { defineRegistryHandler, registryTarget } from '../../../../utils/setup.js'

// `BUCKLE-D12`: minting sits behind the admin credential, which no tool reads; the secret is returned
// once, and never cached on the way (review L9 of B15-B17).
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, views, audited, body }) => {
    const input = views.tokenInput((await body()) ?? {})
    const id = registryTarget(event, workspaces)
    const minted = await audited({ tool: 'workspace_token_add', workspaceId: id }, () => workspaces.addToken(id, input))
    return json({ token: minted }, { status: 201, headers: { 'cache-control': 'no-store' } })
  },
})
