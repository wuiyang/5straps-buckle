import { InvokeRequestSchema } from '@5straps/protocol'
import type { H3Event } from 'h3'
import { statusOf, tolerantLog } from '../../utils/audit.js'
import { readJson } from '../../utils/body.js'
import { mapAgentFailures } from '../../utils/errors.js'
import { requireAgent } from '../../utils/guards.js'
import { ANONYMOUS_SESSION_ID, INVOKE_REFUSED, invokeStatus, recordInvokeRefusal } from '../../utils/invoke.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { json } from '../../utils/respond.js'
import { useTarget } from '../../utils/target.js'

export default defineOperationHandler({
  guards: [requireAgent(INVOKE_REFUSED)],
  handler: async (event) => {
    const { config, runtime } = await useTarget(event)
    // A refusal stands whether or not its entry can be written (B19).
    const refusals = tolerantLog(event, runtime.actions)
    const parsed = await readInvokeRequest(event, config.maxRequestBytes).catch(async (error: unknown) => {
      await recordInvokeRefusal(refusals, runtime.workspaceId, statusOf(error))
      throw error
    })
    if (!parsed.success) {
      await recordInvokeRefusal(refusals, runtime.workspaceId, 400)
      return json({ error: 'Invalid invoke request', issues: parsed.error.issues }, { status: 400 })
    }
    // A caller that supplies no session shares one, so a grant it was just given still applies
    // to its next call. A fresh id per request made every session grant dead on arrival.
    const sessionId = parsed.data.context?.sessionId ?? ANONYMOUS_SESSION_ID
    // A required audit write that fails refuses the call before it runs: busy state is a retryable 503,
    // with no path in it (review L3 of B15-B17).
    const response = await mapAgentFailures(() => runtime.invoke({ request: parsed.data, sessionId, signal: event.req.signal }))
    return json(response, { status: invokeStatus(response) })
  },
})

async function readInvokeRequest(event: H3Event, limit: number) {
  return InvokeRequestSchema.safeParse(await readJson(event, limit))
}
