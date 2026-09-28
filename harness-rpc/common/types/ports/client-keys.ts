import type { KeyObject } from 'node:crypto'

/** A person's client key the owner enrolled on this node (owner ruling H4 of 2026-09-28). */
export interface EnrolledKey {
  /** `SHA256:` fingerprint of the public key: its name in every signed request and audit entry. */
  keyId: string
  publicKey: string
  label: string
  enrolledAt: string
  revokedAt: string | null
}

/**
 * The node's trusted client keys, like SSH's authorized_keys: enrolled, listed and revoked by the
 * owner's local CLI only, never over HTTP. Read at every check, so a revocation applies at once.
 */
export interface ClientKeys {
  list(): EnrolledKey[]
  /** Refuses a key revoked before: a revoked key is taken as lost, and its holder enrolls a new one. */
  enroll(input: { publicKey: string; label: string }): Promise<EnrolledKey>
  /** False when no enrolled key has the id; revoking twice keeps the first time. */
  revoke(keyId: string): Promise<boolean>
  /** The key to verify with, or null for one never enrolled, revoked, or unreadable. */
  publicKeyFor(keyId: string): KeyObject | null
}
