import { KeyIdSchema, keyIdOf, publicKeyFrom, PublicKeyTextSchema } from '@5straps/protocol/signed-request'
import { z } from 'zod'
import type { ClientKeys, EnrolledKey } from '../../types/ports/client-keys.js'
import { createJsonFileStore } from '../json-file-store.js'
import { logger } from '../../runtime/log.js'

const fileSchema = z.object({
  version: z.literal(1),
  keys: z.array(z.object({
    keyId: KeyIdSchema,
    publicKey: PublicKeyTextSchema,
    label: z.string().max(120),
    enrolledAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  }).strict()),
})

/** A key the owner cannot enroll: malformed, or revoked before. The CLI prints the message. */
export class ClientKeyError extends Error {}

/**
 * client-keys.json in the node's state directory, owner-only like every state file there, which the
 * rules refuse to every tool and the sandbox hides from every command. Public keys only: no private
 * key is ever written on the node.
 */
export function createFileClientKeys(input: { filePath: string; lockDeadlineMs?: number }): ClientKeys {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, keys: [] }, lockDeadlineMs: input.lockDeadlineMs })
  return {
    list: () => store.read().keys,
    enroll({ publicKey, label }) {
      let keyId: string
      try {
        keyId = keyIdOf(publicKey.trim())
      } catch {
        throw new ClientKeyError('Not an Ed25519 public key: pass the line `buckle client key` prints, ed25519: followed by 43 characters')
      }
      return store.update((state): EnrolledKey => {
        const existing = state.keys.find(key => key.keyId === keyId)
        if (existing?.revokedAt) throw new ClientKeyError(`Key ${keyId} was revoked; generate a new key with buckle client keygen and enroll that`)
        if (existing) return existing
        const enrolled = { keyId, publicKey: publicKey.trim(), label: label.trim(), enrolledAt: new Date().toISOString(), revokedAt: null }
        state.keys.push(enrolled)
        return enrolled
      })
    },
    revoke(keyId) {
      return store.update((state) => {
        const key = state.keys.find(item => item.keyId === keyId)
        if (!key) return false
        key.revokedAt ??= new Date().toISOString()
        return true
      })
    },
    publicKeyFor(keyId) {
      try {
        const key = store.read().keys.find(item => item.keyId === keyId && item.revokedAt === null)
        return key ? publicKeyFrom(key.publicKey) : null
      } catch (error) {
        // An unreadable list trusts nobody; the owner's log says why.
        logger.error('Could not read the enrolled client keys', { error })
        return null
      }
    },
  }
}
