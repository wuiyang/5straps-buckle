import { ENVELOPE_WINDOW_MS } from '@5straps/protocol/envelope'
import { z } from 'zod'
import type { NonceClaims } from '../../types/ports/nonce-claims.js'
import { createJsonFileStore } from '../json-file-store.js'

const NonceFileSchema = z.object({
  version: z.literal(1),
  nonces: z.array(z.object({ keyId: z.string(), nonce: z.string(), ts: z.number() })),
})
type NonceFile = z.infer<typeof NonceFileSchema>

/**
 * The nonces of sealed approval decisions this node has opened, kept in the state directory so a
 * restart inside the window does not let a captured decision land a second time. Entries whose
 * timestamp has left the window are pruned on load and on every claim: the window itself refuses those.
 */
export async function openFileNonceStore(input: { filePath: string; now?: () => number }): Promise<NonceClaims> {
  const store = createJsonFileStore({ filePath: input.filePath, schema: NonceFileSchema, fallback: { version: 1 as const, nonces: [] } })
  await store.update(state => prune(state, (input.now ?? Date.now)()))
  return {
    withClaims: use => store.update(state => use({
      claim({ keyId, nonce, ts, now }) {
        prune(state, now)
        if (state.nonces.some(entry => entry.keyId === keyId && entry.nonce === nonce)) return false
        state.nonces.push({ keyId, nonce, ts })
        return true
      },
    })),
  }
}

function prune(state: NonceFile, now: number): void {
  state.nonces = state.nonces.filter(entry => entry.ts >= now - ENVELOPE_WINDOW_MS)
}
