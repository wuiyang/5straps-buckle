import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'tools',
  handler: ({ workspace }) => workspace.runtime.toolCatalog(),
})
