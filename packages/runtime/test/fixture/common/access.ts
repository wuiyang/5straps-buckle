import { createHash, timingSafeEqual } from 'node:crypto'

export type Credential = 'agent' | 'admin'

export interface AccessService {
  // Returns the actor for a valid credential of exactly this kind, else undefined.
  verify(kind: Credential, presented: string | undefined): string | undefined
}

export function createAccessService(tokens: Record<Credential, string>): AccessService {
  const digests = { agent: digest(tokens.agent), admin: digest(tokens.admin) }
  return {
    verify(kind, presented) {
      if (!presented) return undefined
      return timingSafeEqual(digest(presented), digests[kind]) ? kind : undefined
    },
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}
