import { getRouterParam } from 'h3'
import { notFound } from '../../../../../../../common/server/utils/errors.js'
import { noContent } from '../../../../../../../common/server/utils/respond.js'
import { withRegistryAudit } from '../../../../../utils/audit.js'
import { defineRegistryHandler } from '../../../../../utils/setup.js'

// `BUCKLE-D12`: revoking sits behind the admin credential; a call presenting the token is refused at once.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, actions }) => {
    const id = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
    const tokenId = getRouterParam(event, 'tokenId', { decode: true }) ?? ''
    if (!await withRegistryAudit(actions, { tool: 'workspace_token_revoke', workspaceId: id }, () => workspaces.revokeToken(id, tokenId))) throw notFound('Workspace token not found')
    return noContent()
  },
})
