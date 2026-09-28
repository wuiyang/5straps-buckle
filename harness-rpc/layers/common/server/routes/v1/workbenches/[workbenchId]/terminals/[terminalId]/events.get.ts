import { defineWorkbenchHandler } from '../../../../../../utils/workbench.js'

// ?after= is the last event the caller has; a missing one reads from the start.
export default defineWorkbenchHandler(async ({ event, workbenches, workbenchId, param }) => workbenches.terminalEvents(workbenchId, param('terminalId'), Number(event.url.searchParams.get('after') ?? '0')))
