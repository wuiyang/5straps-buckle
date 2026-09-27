import { ENVELOPE_WINDOW_MS, type NonceStore } from '@5straps/protocol/envelope'
import { z } from 'zod'
import { createJsonFileStore } from '../json-file-store.js'

const NonceFileSchema = z.object({
  version: z.literal(1),
  nonces: z.array(z.object({ keyId: z.string(), nonce: z.string(), ts: z.number() })),
})

/**
 * The nonces of sealed approval decisions this node has opened, kept in the state directory so a
 * restart inside the window does not let a captured decision land a second time. Entries whose
 * timestamp has left the window are pruned on load and on every claim: the window itself refuses those.
 */
export function createFileNonceStore(input: { filePath: string; now?: () => number }): NonceStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: NonceFileSchema, fallback: { version: 1 as const, nonces: [] } })
  const prune = (state: z.infer<typeof NonceFileSchema>, now: number) => {
    state.nonces = state.nonces.filter(entry => entry.ts >= now - ENVELOPE_WINDOW_MS)
  }
  store.update(state => prune(state, (input.now ?? Date.now)()))
  return {
    claim: ({ keyId, nonce, ts, now }) => store.update(state => {
      prune(state, now)
      if (state.nonces.some(entry => entry.keyId === keyId && entry.nonce === nonce)) return false
      state.nonces.push({ keyId, nonce, ts })
      return true
    }),
  }
}
