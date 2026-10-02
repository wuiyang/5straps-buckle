import { HTTPError } from 'h3'
import { z } from 'zod'
import { historyAnswer } from '../../../utils/history.js'
import { defineSetupHandler } from '../../../utils/setup.js'

const StageRestoreSchema = z.object({ stageId: z.string().min(1), sessionId: z.string().min(1) })

export default defineSetupHandler({
  access: 'setup',
  resource: 'history-stages',
  handler: async ({ event, workspace, body }) => {
    const parsed = StageRestoreSchema.safeParse(await body())
    if (!parsed.success) throw HTTPError.status(400, 'Bad Request', { message: 'stageId and sessionId are required' })
    return historyAnswer(event, () => workspace.runtime.history.restoreStage(parsed.data.stageId, parsed.data.sessionId))
  },
})
