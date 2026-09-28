import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'setup',
  resource: 'policy',
  handler: async ({ workspace, views }) => {
    await workspace.runtime.policy.clear()
    return views.policy(workspace)
  },
})
