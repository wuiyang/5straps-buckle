import { HTTPError } from 'h3'
import { z } from 'zod'
import { defineSetupHandler } from '../../utils/setup.js'

const AuditPageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().nonnegative().optional() })

// Inspection reads the log as it stands: interrupted calls are recovered when a runtime opens, never
// by a read (review L4 of B15-B17). The request's own setup_get_audit entry is the one write.
export default defineSetupHandler({
  access: 'inspection',
  resource: 'audit',
  handler: ({ workspace, query }) => {
    const parsed = AuditPageSchema.safeParse(query())
    if (!parsed.success) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid audit page' })
    return workspace.runtime.actions.page(parsed.data)
  },
})
