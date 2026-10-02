import { getRouterParam } from 'h3'
import { notFound } from '../../../../../common/server/utils/errors.js'
import { defineRegistryHandler } from '../../../utils/setup.js'

export default defineRegistryHandler({
  access: 'inspection',
  handler: ({ event, workspaces }) => {
    const id = getRouterParam(event, 'workspaceId', { decode: true })
    const workspace = workspaces.list().find(item => item.id === id)
    if (!workspace) throw notFound('Workspace not found')
    return { workspace }
  },
})
