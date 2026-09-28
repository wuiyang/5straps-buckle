import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'history',
  handler: async ({ workspace }) => ({ checkpoints: await workspace.runtime.history.list() }),
})
