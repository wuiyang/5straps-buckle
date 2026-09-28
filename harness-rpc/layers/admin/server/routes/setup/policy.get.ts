import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'policy',
  handler: ({ workspace, views }) => views.policy(workspace),
})
