import { tolerantLog } from '../../utils/audit.js'
import { mapAgentFailures } from '../../utils/errors.js'
import { FILES_REFUSED, FILES_STATUS, filesWait, receiveRequest, recordFilesRefusal } from '../../utils/files.js'
import { requireAgent } from '../../utils/guards.js'
import { invokeStatus } from '../../utils/invoke.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { json } from '../../utils/respond.js'
import { useTarget } from '../../utils/target.js'

/**
 * `buckle cp` into a workspace (the copy-verb brief): one file as the raw body, judged as fs_receive before any byte of
 * it is read, so a copy that needs a person waits with its body unread, and one refused keeps nothing. The body reaches
 * the tool through the call's context, never its arguments, and lands beside the target until it is whole and matches
 * its digest. An answer that leaves the body unread goes out at once: node:http drains the rest unread, and `buckle cp`
 * stops sending it as it reads the answer. Closing the connection instead resets it, with the body's bytes still
 * unread, and a reset can lose the answer before the caller reads it.
 */
export default defineOperationHandler({
  guards: [requireAgent(FILES_REFUSED)],
  handler: async (event) => {
    const { config, runtime } = await useTarget(event)
    const parsed = receiveRequest(event, config.maxTransferBytes)
    if (!parsed.ok) {
      // A refusal stands whether or not its entry can be written (B19).
      await recordFilesRefusal(tolerantLog(event, runtime.actions), runtime.workspaceId, parsed.status)
      return json({ error: parsed.error }, { status: parsed.status })
    }
    const response = await mapAgentFailures(() => runtime.invoke({
      request: parsed.request, sessionId: parsed.sessionId, signal: event.req.signal, approvalWait: filesWait(config.approvalTimeoutMs),
      file: { kind: 'receive', body: event.req.body },
    }))
    return json(response, { status: invokeStatus(response, FILES_STATUS) })
  },
})
