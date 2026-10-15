import { getRouterParam } from 'h3'
import { notFound } from '../../../../../../../common/server/utils/errors.js'
import { noContent } from '../../../../../../../common/server/utils/respond.js'
import { defineRegistryHandler, registryTarget } from '../../../../../utils/setup.js'

// `BUCKLE-D12`: revoking sits behind the admin credential; a call presenting the token is refused at once.
export default defineRegistryHandler({
  access: 'setup',
  handler: async ({ event, workspaces, audited }) => {
    const id = registryTarget(event, workspaces)
    const tokenId = getRouterParam(event, 'tokenId', { decode: true }) ?? ''
    if (!await audited({ tool: 'workspace_token_revoke', workspaceId: id }, () => workspaces.revokeToken(id, tokenId))) throw notFound('Workspace token not found')
    return noContent()
  },
})
