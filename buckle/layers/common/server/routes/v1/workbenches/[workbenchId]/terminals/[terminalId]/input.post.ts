import { WorkbenchTerminalInputSchema } from '@5straps/protocol'
import { defineWorkbenchHandler } from '../../../../../../utils/workbench.js'

export default defineWorkbenchHandler(async ({ workbenches, workbenchId, param, body }) => workbenches.terminalInput(workbenchId, param('terminalId'), await body(WorkbenchTerminalInputSchema)))
