import { defineWorkbenchHandler } from '../../../utils/workbench.js'

export default defineWorkbenchHandler(async ({ workbenches, workbenchId }) => ({ workbench: await workbenches.get(workbenchId) }))
