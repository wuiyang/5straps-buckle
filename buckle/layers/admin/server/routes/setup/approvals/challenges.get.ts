import { useServices } from '../../../../../common/server/utils/services.js'
import { defineSetupHandler } from '../../../utils/setup.js'

/** What the listing says in place of a challenge the node could not sign; it names no field and no value. */
const UNSIGNABLE = 'The node could not sign this ask\'s challenge, so no device can decide it; answer it at the node (buckle approve) or withdraw the call'
/**
 * What it says for an ask whose whole call the node does not hold (owner decision D17): one recorded before this
 * build, or whose kept call is missing or damaged (slice 7 review R7-RR-4). The text stays as it is, since every
 * client maps it to its own words and reads any other as an unrecognised entry.
 */
const RECORDED_BEFORE = 'recorded before this build: decide at the node or re-send'

// The approval guard: each waiting ask as the node signs it (B24; approval-proofs.md, Signed
// request). A person's client verifies the node's signature with the node key it pinned, shows the
// raw action from the verified challenge, and signs its decision over the challenge's digest. Each
// ask is signed on its own: one the node cannot sign is listed as an error for its token, and every
// other ask stays decidable (review M3 of the second proof-of-possession re-review). A call too large
// to repeat in each of its asks' challenges is listed once in `calls`, by the call digest its
// challenges sign; the client recomputes that digest from it (review M1 of the slice 5 re-review).
export default defineSetupHandler({
  access: 'approval',
  resource: 'approvals-challenges',
  handler: async ({ event, workspace }) => {
    const signer = await useServices(event).getNodeSigner()
    const listing = workspace.runtime.approvalService.challengeListing()
    return {
      node: { keyId: signer.keyId, publicKey: signer.publicKey },
      calls: listing.calls,
      challenges: listing.challenges.map(({ token, challenge }) => {
        if (challenge === null) return { token, error: RECORDED_BEFORE }
        try {
          return { token, ...signer.signChallenge(challenge) }
        } catch (error) {
          event.context.logger?.warn('Could not sign an approval challenge', { workspaceId: workspace.runtime.workspaceId, tool: challenge.tool, error: error instanceof Error ? error.name : 'Unknown error' })
          return { token, error: UNSIGNABLE }
        }
      }),
    }
  },
})
