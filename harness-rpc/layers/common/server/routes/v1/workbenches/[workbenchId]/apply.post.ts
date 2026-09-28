import { WorkbenchApplySchema } from '@5straps/protocol'
import { defineWorkbenchHandler } from '../../../../utils/workbench.js'

export default defineWorkbenchHandler(async ({ workbenches, workbenchId, body }) => workbenches.apply(workbenchId, await body(WorkbenchApplySchema)))
