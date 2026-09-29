import type { EnrolledKeyLookup, SignedRequestPurpose } from '@5straps/protocol/signed-request'

/** What an enrolled key may sign (owner decision D10): setup changes, approval decisions, or both. */
export type KeyPurpose = 'setup' | 'approval' | 'both'

/** The workspace scope a key signs for: one workspace id, or `node` for every workspace and the registry. */
export const NODE_SCOPE = 'node'

/** A person's client key the owner enrolled on this node (owner ruling H4 of 2026-09-28). */
export interface EnrolledKey {
  /** `SHA256:` fingerprint of the public key: its name in every signed request and audit entry. */
  keyId: string
  publicKey: string
  label: string
  purpose: KeyPurpose
  /** A workspace id, or `node`. */
  workspace: string
  enrolledAt: string
  revokedAt: string | null
}

/** What a signed request asks a key to be good for; `registry` marks a change to the node's workspace registry. */
export interface KeyUse {
  purpose: SignedRequestPurpose
  workspace: string
  registry: boolean
}

/**
 * The node's trusted client keys, like SSH's authorized_keys: enrolled, listed and revoked by the
 * owner's local CLI only, never over HTTP. Read at every check, so a revocation applies at once.
 */
export interface ClientKeys {
  list(): EnrolledKey[]
  /**
   * Refuses a key revoked before: a revoked key is taken as lost, and its holder enrolls a new one.
   * The scope is fixed at enrollment: enrolling the same key with another one is refused.
   */
  enroll(input: { publicKey: string; label: string; purpose: KeyPurpose; workspace: string }): Promise<EnrolledKey>
  /** False when no enrolled key has the id; revoking twice keeps the first time. */
  revoke(keyId: string): Promise<boolean>
  /** The key to verify with, or why it may not sign this use: never enrolled, revoked, unreadable, or out of scope. */
  publicKeyFor(keyId: string, use: KeyUse): EnrolledKeyLookup
}
