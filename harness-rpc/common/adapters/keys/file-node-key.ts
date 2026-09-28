import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { generateSigningKey, signingKeyFromPem, type SigningKey } from '@5straps/protocol/signed-request'

/**
 * The node's own Ed25519 signing identity (keys-provisioning.md: Buckle signs requests with its
 * machine key; the trusted client verifies those): made once, owner-only, in the node's state
 * directory, and never shown but its public half. A separate purpose from every person's key.
 */
export function loadNodeKey(filePath: string): SigningKey & { publicKey: string } {
  if (!existsSync(filePath)) {
    try {
      writeFileSync(filePath, generateSigningKey().privateKeyPem, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // Another process of this node made it first; its key is the node's.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if ((statSync(filePath).mode & 0o077) !== 0) throw new Error(`${filePath} can be read by other users; run chmod 600 ${filePath}`)
  return signingKeyFromPem(readFileSync(filePath, 'utf8'))
}
