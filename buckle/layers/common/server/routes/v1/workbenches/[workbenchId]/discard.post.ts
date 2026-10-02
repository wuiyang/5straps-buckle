import { WorkbenchActorInputSchema } from '@5straps/protocol'
import { defineWorkbenchHandler } from '../../../../utils/workbench.js'

export default defineWorkbenchHandler(async ({ workbenches, workbenchId, body }) => workbenches.discard(workbenchId, (await body(WorkbenchActorInputSchema)).actorId))
