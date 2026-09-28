import { WorkbenchActorInputSchema } from '@5straps/protocol'
import { defineWorkbenchHandler } from '../../../../../../utils/workbench.js'

export default defineWorkbenchHandler(async ({ workbenches, workbenchId, param, body }) => workbenches.stopTerminal(workbenchId, param('terminalId'), (await body(WorkbenchActorInputSchema)).actorId))
