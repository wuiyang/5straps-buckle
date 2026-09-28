import { HTTPError } from 'h3'
import { z } from 'zod'
import { defineSetupHandler } from '../../utils/setup.js'

const AuditPageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().nonnegative().optional() })

// Interrupted calls are recovered first, so the page shows them as interrupted rather than started.
export default defineSetupHandler({
  access: 'inspection',
  resource: 'audit',
  handler: async ({ workspace, query }) => {
    const parsed = AuditPageSchema.safeParse(query())
    if (!parsed.success) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid audit page' })
    await workspace.runtime.actions.recoverInterrupted()
    return workspace.runtime.actions.page(parsed.data)
  },
})
