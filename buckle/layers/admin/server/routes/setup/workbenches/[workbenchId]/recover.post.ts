import { getRouterParam } from 'h3'
import { workbenchAnswer } from '../../../../../../common/server/utils/workbench.js'
import { defineSetupHandler } from '../../../../utils/setup.js'

export default defineSetupHandler({
  access: 'setup',
  resource: 'workbenches',
  active: true,
  handler: ({ event, workspace }) => workbenchAnswer(event, () => workspace.runtime.workbenches.recover(getRouterParam(event, 'workbenchId', { decode: true }) ?? '')),
})
