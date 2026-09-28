import { getRouterParam } from 'h3'
import { historyAnswer } from '../../../../utils/history.js'
import { defineSetupHandler } from '../../../../utils/setup.js'

export default defineSetupHandler({
  access: 'setup',
  resource: 'history',
  handler: ({ event, workspace }) => historyAnswer(event, () => workspace.runtime.history.recover(getRouterParam(event, 'checkpointId', { decode: true }) ?? '')),
})
