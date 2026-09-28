import { workbenchAnswer } from '../../../../common/server/utils/workbench.js'
import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'workbenches',
  // Inspection reads the stored records; it takes no ownership and recovers nothing (review L4 of B15-B17).
  handler: ({ event, workspace }) => workbenchAnswer(event, async () => ({ workbenches: workspace.runtime.workbenches.inspect() })),
})
