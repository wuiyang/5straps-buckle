import { KeyIdSchema, keyIdOf, publicKeyFrom, PublicKeyTextSchema, SmallOrderKeyError, type EnrolledKeyLookup } from '@5straps/protocol/signed-request'
import { z } from 'zod'
import { NODE_SCOPE, type ClientKeys, type EnrolledKey, type KeyUse } from '../../types/ports/client-keys.js'
import { createJsonFileStore } from '../json-file-store.js'
import { logger } from '../../runtime/log.js'

const fileSchema = z.object({
  version: z.literal(1),
  keys: z.array(z.object({
    keyId: KeyIdSchema,
    publicKey: PublicKeyTextSchema,
    label: z.string().max(120),
    purpose: z.enum(['setup', 'approval', 'both']),
    workspace: z.string().min(1).max(64),
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
    enroll({ publicKey, label, purpose, workspace }) {
      let keyId: string
      try {
        keyId = keyIdOf(publicKey.trim())
      } catch (error) {
        if (error instanceof SmallOrderKeyError) throw new ClientKeyError(error.message)
        throw new ClientKeyError('Not an Ed25519 public key: pass the line `buckle client key` prints, ed25519: followed by 43 characters')
      }
      return store.update((state): EnrolledKey => {
        const existing = state.keys.find(key => key.keyId === keyId)
        if (existing?.revokedAt) throw new ClientKeyError(`Key ${keyId} was revoked; generate a new key with buckle client keygen and enroll that`)
        if (existing && (existing.purpose !== purpose || existing.workspace !== workspace)) {
          throw new ClientKeyError(`Key ${keyId} is already enrolled for ${describeScope(existing)}; a scope is fixed at enrollment, so revoke it and enroll a new key for another one`)
        }
        if (existing) return existing
        const enrolled = { keyId, publicKey: publicKey.trim(), label: label.trim(), purpose, workspace, enrolledAt: new Date().toISOString(), revokedAt: null }
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
    publicKeyFor(keyId, use): EnrolledKeyLookup {
      let key: EnrolledKey | undefined
      try {
        key = store.read().keys.find(item => item.keyId === keyId && item.revokedAt === null)
      } catch (error) {
        // An unreadable list trusts nobody; the owner's log says why.
        logger.error('Could not read the enrolled client keys', { error })
        return { refused: 'unknown_key' }
      }
      if (!key) return { refused: 'unknown_key' }
      try {
        // Scope is judged after the signature (checkSignedRequest), so a refusal names a key that signed.
        return { key: publicKeyFrom(key.publicKey), covers: covers(key, use) }
      } catch (error) {
        // A small-order key enrolled before they were refused trusts nobody.
        logger.error('An enrolled client key cannot verify anything', { keyId, error })
        return { refused: 'unknown_key' }
      }
    },
  }
}

/**
 * Whether a key's scope covers one use (owner decision D10): its purpose, and its workspace or the
 * node. A change to the node's workspace registry needs a node-scoped key.
 */
function covers(key: EnrolledKey, use: KeyUse): boolean {
  const purpose = use.purpose === 'buckle-setup' ? 'setup' : 'approval'
  if (key.purpose !== 'both' && key.purpose !== purpose) return false
  if (key.workspace === NODE_SCOPE) return true
  return !use.registry && key.workspace === use.workspace
}

/** A key's scope as `buckle keys list` and its refusals name it. */
export function describeScope(key: Pick<EnrolledKey, 'purpose' | 'workspace'>): string {
  const purpose = key.purpose === 'both' ? 'setup and approval' : key.purpose
  return `${purpose} on ${key.workspace === NODE_SCOPE ? 'the whole node' : `workspace ${key.workspace}`}`
}
