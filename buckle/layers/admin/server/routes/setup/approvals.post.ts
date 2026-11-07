import { HTTPError } from 'h3'
import { recordRefusal, tolerantLog } from '../../../../common/server/utils/audit.js'
import { defineSetupHandler } from '../../utils/setup.js'

// The approval guard: a decision, plain or in the envelope the paired key seals, decided through the core approval API.
// A refused envelope is audited with its reason and never its body. A request an enrolled key signed carries its decision
// plain: the signature over its exact body is the proof the request verifier minted, and the decision is the devices source's.
// A proof that does not carry the body read, or was spent, is audited as a device's refusal.
const PROOF_REFUSALS = {
  envelope: { tool: 'setup_approval_envelope_refused', line: 'Refused an approval decision envelope' },
  device: { tool: 'setup_approval_proof_refused', line: 'Refused a device\'s approval decision proof' },
} as const

export default defineSetupHandler({
  access: 'approval',
  resource: 'approvals',
  handler: async ({ event, proof, workspace, body, audit }) => {
    const { runtime } = workspace
    const sent = (await body()) ?? null
    const receipt = await runtime.approvalApi.decide(proof === undefined ? { source: 'sealed', body: sent } : { source: 'devices', body: sent, proof })
    // What a decision the guard checked said, beside the actor that signed or carried it (keys-provisioning.md: every
    // approval and denial is logged with key identity and scope).
    const record = runtime.approvalApi.decisionRecord(receipt)
    if (record) audit({ ...record })
    if (receipt.status !== 'refused') return { resolved: true, ...(receipt.grantOwed ? { grantOwed: true } : {}) }
    if (receipt.step === 'proof') {
      const refusal = PROOF_REFUSALS[proof === undefined ? 'envelope' : 'device']
      await recordRefusal(tolerantLog(event, runtime.actions), { tool: refusal.tool, workspaceId: runtime.workspaceId, sessionId: 'workspace-admin', status: 401, detail: receipt.error.message })
      event.context.logger?.warn(refusal.line, { reason: receipt.error.message, workspaceId: runtime.workspaceId })
      throw HTTPError.status(401, 'Unauthorized', { message: `Approval decision refused: ${receipt.error.message}` })
    }
    if (receipt.step === 'statement') throw HTTPError.status(400, 'Bad Request', { message: 'Invalid approval decision' })
    throw HTTPError.status(409, 'Conflict', { message: receipt.error.message })
  },
})
