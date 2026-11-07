import { HTTPError } from 'h3'
import { decisionRecord } from '../../../../../common/services/approvals/core-approval-api.js'
import { recordRefusal, tolerantLog } from '../../../../common/server/utils/audit.js'
import { defineSetupHandler } from '../../utils/setup.js'

// The approval guard: a decision, plain or in the envelope the paired key seals, decided through the core approval API.
// A refused envelope is audited with its reason and never its body. A request an enrolled key signed carries its decision
// plain: the signature over its exact body is the proof the request verifier minted, and the decision is the devices source's.
export default defineSetupHandler({
  access: 'approval',
  resource: 'approvals',
  handler: async ({ event, proof, workspace, body, audit }) => {
    const { runtime } = workspace
    const sent = (await body()) ?? null
    const receipt = await runtime.approvalApi.decide(proof === undefined ? { source: 'sealed', body: sent } : { source: 'devices', body: sent, proof })
    // What a decision the guard checked said, beside the actor that signed or carried it (keys-provisioning.md: every
    // approval and denial is logged with key identity and scope).
    const record = decisionRecord(receipt)
    if (record) audit({ ...record })
    if (receipt.status !== 'refused') return { resolved: true, ...(receipt.grantOwed ? { grantOwed: true } : {}) }
    if (receipt.step === 'proof') {
      await recordRefusal(tolerantLog(event, runtime.actions), { tool: 'setup_approval_envelope_refused', workspaceId: runtime.workspaceId, sessionId: 'workspace-admin', status: 401, detail: receipt.error.message })
      event.context.logger?.warn('Refused an approval decision envelope', { reason: receipt.error.message, workspaceId: runtime.workspaceId })
      throw HTTPError.status(401, 'Unauthorized', { message: `Approval decision refused: ${receipt.error.message}` })
    }
    if (receipt.step === 'statement') throw HTTPError.status(400, 'Bad Request', { message: 'Invalid approval decision' })
    throw HTTPError.status(409, 'Conflict', { message: receipt.error.message })
  },
})
