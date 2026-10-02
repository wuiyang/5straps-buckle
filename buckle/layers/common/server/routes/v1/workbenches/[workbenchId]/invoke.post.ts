import { WorkbenchInvokeSchema } from '@5straps/protocol'
import { defineWorkbenchHandler } from '../../../../utils/workbench.js'

export default defineWorkbenchHandler(async ({ workbenches, workbenchId, body }) => workbenches.invoke(workbenchId, await body(WorkbenchInvokeSchema)))
