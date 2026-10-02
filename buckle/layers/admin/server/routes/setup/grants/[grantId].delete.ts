import { getRouterParam } from 'h3'
import { notFound } from '../../../../../common/server/utils/errors.js'
import { noContent } from '../../../../../common/server/utils/respond.js'
import { defineSetupHandler } from '../../../utils/setup.js'

export default defineSetupHandler({
  access: 'setup',
  resource: 'grants',
  handler: async ({ event, workspace }) => {
    if (!await workspace.runtime.grants.revoke(getRouterParam(event, 'grantId', { decode: true }) ?? '')) throw notFound('Grant not found')
    return noContent()
  },
})
