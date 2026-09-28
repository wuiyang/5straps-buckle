import { useServices } from '../../../../../common/server/utils/services.js'
import { defineSetupHandler } from '../../../utils/setup.js'

// The approval guard: each waiting ask as the node signs it (B24; approval-proofs.md, Signed
// request). A person's client verifies the node's signature with the node key it pinned, shows the
// raw action from the verified challenge, and signs its decision over the challenge's digest.
export default defineSetupHandler({
  access: 'approval',
  resource: 'approvals-challenges',
  handler: async ({ event, workspace }) => {
    const signer = await useServices(event).getNodeSigner()
    return {
      node: { keyId: signer.keyId, publicKey: signer.publicKey },
      challenges: workspace.runtime.approvalService.challenges().map(({ token, challenge }) => ({ token, ...signer.signChallenge(challenge) })),
    }
  },
})
