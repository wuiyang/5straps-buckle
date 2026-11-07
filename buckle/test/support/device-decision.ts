import { mintDeviceProof } from '../../common/services/approvals/device-proof.js'
import type { CoreDecisionInput } from '../../common/services/approvals/core-approval-api.js'

/** A setup POST's body as an enrolled device signed it, with the proof the node's request verifier mints for those bytes. */
export function deviceDecision(body: unknown, signer: { keyId?: string; deadline?: number } = {}): Extract<CoreDecisionInput, { source: 'devices' }> {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { source: 'devices', body, proof: mintDeviceProof({ keyId: signer.keyId ?? 'device-1', deadline: signer.deadline ?? Date.now() + 60_000, body: bytes }) }
}
