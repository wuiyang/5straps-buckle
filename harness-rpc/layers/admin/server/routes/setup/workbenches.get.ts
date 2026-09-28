import { workbenchAnswer } from '../../../../common/server/utils/workbench.js'
import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'workbenches',
  handler: ({ event, workspace }) => workbenchAnswer(event, async () => ({ workbenches: await workspace.runtime.workbenches.list() })),
})
