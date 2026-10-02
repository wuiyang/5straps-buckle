import { notFound } from '../../../utils/errors.js'
import { requireAgent } from '../../../utils/guards.js'
import { defineOperationHandler } from '../../../utils/operation.js'

// Any other path under a workspace: its agent credential first, then 404. The MCP and admin layers
// serve their own paths below /workspaces/[id]/, which are more specific than this one.
export default defineOperationHandler({
  guards: [requireAgent()],
  handler: () => { throw notFound() },
})
