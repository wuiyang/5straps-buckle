import { getRouterParam } from 'h3'
import { json } from '../../../../../../common/server/utils/respond.js'
import { withRegistryAudit } from '../../../../utils/audit.js'
import { defineRegistryHandler } from '../../../../utils/setup.js'

// `BUCKLE-D12`: minting sits behind the admin credential, which no tool reads; the secret is returned once.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, views, actions, body }) => {
    const input = views.tokenInput((await body()) ?? {})
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    const minted = await withRegistryAudit(actions, { tool: 'workspace_token_add', workspaceId: id }, () => workspaces.addToken(id, input))
    return json({ token: minted }, { status: 201 })
  },
})
