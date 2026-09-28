import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'grants',
  handler: ({ workspace }) => ({ grants: workspace.runtime.grants.list() }),
})
