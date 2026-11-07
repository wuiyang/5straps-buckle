declare const VERIFIED: unique symbol

/**
 * A request an enrolled device's key signed for an approval, as this node's request verifier checked it: the key it
 * names and the proof's deadline in ms. Only the verifier mints one, once the signature checked and its nonce was claimed.
 */
export interface DeviceProof {
  readonly keyId: string
  readonly deadline: number
  readonly [VERIFIED]: true
}

const minted = new WeakSet<object>()

export function mintDeviceProof(input: { keyId: string; deadline: number }): DeviceProof {
  // The brand exists only in the type: the WeakSet is what tells a minted proof from a look-alike.
  const proof = Object.freeze({ keyId: input.keyId, deadline: input.deadline }) as DeviceProof
  minted.add(proof)
  return proof
}

export function isDeviceProof(value: unknown): value is DeviceProof {
  return typeof value === 'object' && value !== null && minted.has(value)
}
