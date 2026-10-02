import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'status',
  handler: ({ workspace, views }) => views.status(workspace),
})
