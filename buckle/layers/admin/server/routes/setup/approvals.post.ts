import { HTTPError } from 'h3'
import { recordRefusal, tolerantLog } from '../../../../common/server/utils/audit.js'
import { defineSetupHandler } from '../../utils/setup.js'

// The approval guard: a decision, plain or in the envelope Rings seals, answered through the approval
// service as the owner. A refused envelope is audited with its reason and never its body. A request
// an enrolled key signed carries its decision plain: the signature over its exact body is the proof.
export default defineSetupHandler({
  access: 'approval',
  resource: 'approvals',
  handler: async ({ event, actor, proofDeadline, workspace, body, audit }) => {
    const { runtime } = workspace
    const decided = await runtime.approvalService.decideSealed({ body: (await body()) ?? null, signedBy: actor.startsWith('key:') ? actor : undefined, proofDeadline })
    // What an opened decision said, beside the actor that signed or carried it (keys-provisioning.md: every
    // approval and denial is logged with key identity and scope; review item 6 of the proof-of-possession fixes).
    if (decided.status === 'answered' || decided.status === 'rejected') audit({ ...decided.decided })
    if (decided.status === 'refused') {
      await recordRefusal(tolerantLog(event, runtime.actions), { tool: 'setup_approval_envelope_refused', workspaceId: runtime.workspaceId, sessionId: 'workspace-admin', status: 401, detail: decided.reason })
      event.context.logger?.warn('Refused an approval decision envelope', { reason: decided.reason, workspaceId: runtime.workspaceId })
      throw HTTPError.status(401, 'Unauthorized', { message: `Approval decision refused: ${decided.reason}` })
    }
    if (decided.status === 'invalid') throw HTTPError.status(400, 'Bad Request', { message: 'Invalid approval decision' })
    if (decided.status === 'rejected') throw HTTPError.status(409, 'Conflict', { message: decided.reason })
    return { resolved: true, ...(decided.decided.grantOwed ? { grantOwed: true } : {}) }
  },
})
