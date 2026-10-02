import { signChallenge, type ApprovalChallenge } from '@5straps/protocol/signed-request'
import { loadNodeKey } from '../../adapters/keys/file-node-key.js'

/** Signs what the node shows a person's client, with the node's own key. */
export interface NodeSigner {
  readonly keyId: string
  readonly publicKey: string
  /** `<challenge>.<signature>` and the challenge's digest, which a decision names. */
  signChallenge(challenge: ApprovalChallenge): { signed: string; digest: string }
}

export function createNodeSigner(filePath: string): NodeSigner {
  const key = loadNodeKey(filePath)
  return { keyId: key.keyId, publicKey: key.publicKey, signChallenge: challenge => signChallenge({ challenge, key: key.privateKey }) }
}
