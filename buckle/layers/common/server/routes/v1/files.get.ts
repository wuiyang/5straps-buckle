import { tolerantLog } from '../../utils/audit.js'
import { mapAgentFailures } from '../../utils/errors.js'
import { alreadySent, FILES_REFUSED, FILES_STATUS, filesWait, outgoingFile, recordFilesRefusal, sendRequest } from '../../utils/files.js'
import { requireAgent } from '../../utils/guards.js'
import { invokeStatus } from '../../utils/invoke.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { json } from '../../utils/respond.js'
import { useTarget } from '../../utils/target.js'

/**
 * `buckle cp` out of a workspace (the copy-verb brief): one file, judged as fs_send, streamed back with its size and
 * sha256 ahead of it. A call that needs a person, or is refused, answers as /v1/invoke does; one that ran answers with
 * the bytes, and the call ends, and is audited, as the last of them goes out or the stream is cut.
 */
export default defineOperationHandler({
  guards: [requireAgent(FILES_REFUSED)],
  handler: async (event) => {
    const { config, runtime } = await useTarget(event)
    const parsed = sendRequest(event)
    if (!parsed.ok) {
      await recordFilesRefusal(tolerantLog(event, runtime.actions), runtime.workspaceId, parsed.status)
      return json({ error: parsed.error }, { status: parsed.status })
    }
    const outgoing = outgoingFile()
    const answering = mapAgentFailures(() => runtime.invoke({
      request: parsed.request, sessionId: parsed.sessionId, signal: event.req.signal, approvalWait: filesWait(config.approvalTimeoutMs), resends: true,
      file: outgoing.channel,
    }))
    const first = await Promise.race([answering.then(response => ({ response })), outgoing.ready.then(file => ({ file }))])
    if ('file' in first) {
      // The call goes on as the bytes go out; its outcome is the stream's, and its audit entry is written as it ends.
      void answering.catch(() => undefined)
      return new Response(first.file.stream, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(first.file.size), 'x-buckle-sha256': first.file.sha256, 'cache-control': 'no-store' } })
    }
    const { response } = first
    if (response.outcome === 'ok') {
      const answer = alreadySent(response)
      return json(answer, { status: invokeStatus(answer) })
    }
    return json(response, { status: invokeStatus(response, FILES_STATUS) })
  },
})
