import { createHash } from 'node:crypto'
import type { JsonValue } from '@5straps/protocol'
import { canonicalJson } from '@5straps/protocol/signed-request'

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

/** Why a proof does not carry a body: never minted, minted for other bytes, or already spent on a decision. */
export type ProofRefusal = 'unverified' | 'replayed'

// The digest of the body each minted proof's signature covered, and whether a decision spent it. The WeakMap is what
// tells a minted proof from a look-alike, since the brand exists only in the type.
const minted = new WeakMap<object, { digest: string | null; spent: boolean }>()

export function mintDeviceProof(input: { keyId: string; deadline: number; body: Uint8Array }): DeviceProof {
  const proof = Object.freeze({ keyId: input.keyId, deadline: input.deadline }) as DeviceProof
  minted.set(proof, { digest: digestOfBytes(input.body), spent: false })
  return proof
}

export function isDeviceProof(value: unknown): value is DeviceProof {
  return typeof value === 'object' && value !== null && minted.has(value)
}

/** Spends the proof on the body a route read, which must be the one its signature covered; a proof carries one decision. */
export function spendDeviceProof(proof: DeviceProof, body: unknown): ProofRefusal | null {
  const held = minted.get(proof)
  if (held === undefined || held.digest === null || held.digest !== digestOf(body)) return 'unverified'
  if (held.spent) return 'replayed'
  held.spent = true
  return null
}

// The route reads the body as JSON, so both sides are compared as canonical JSON, never as raw bytes.
function digestOfBytes(bytes: Uint8Array): string | null {
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // A body that is not JSON carries no decision, so its proof carries none either.
    return null
  }
  return digestOf(body)
}

function digestOf(body: unknown): string {
  // Both sides are JSON.parse output, which is a JsonValue.
  return createHash('sha256').update(canonicalJson(body as JsonValue)).digest('hex')
}
