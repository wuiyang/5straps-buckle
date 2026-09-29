import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { generateSigningKey, signingKeyFromPem, type SigningKey } from '@5straps/protocol/signed-request'

/**
 * The node's own Ed25519 signing identity (keys-provisioning.md: Buckle signs requests with its
 * machine key; the trusted client verifies those): made once, owner-only, in the node's state
 * directory, and never shown but its public half. A separate purpose from every person's key.
 */
export function loadNodeKey(filePath: string): SigningKey & { publicKey: string } {
  if (!existsSync(filePath)) createOnce(filePath)
  if ((statSync(filePath).mode & 0o077) !== 0) throw new Error(`${filePath} can be read by other users; run chmod 600 ${filePath}`)
  try {
    return signingKeyFromPem(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${filePath} does not hold this node's Ed25519 signing key; move it aside and a new one is made when next needed, after which every person's device pins this node again`, { cause: error })
  }
}

/**
 * Writes a fresh key beside the file, synced, then links it into place, so no reader sees half a key
 * (review L11 of B23-B25) and a key another process of this node linked first is kept.
 */
function createOnce(filePath: string): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    try {
      const pem = Buffer.from(generateSigningKey().privateKeyPem)
      if (writeSync(descriptor, pem) !== pem.length) throw new Error(`Could not write all of ${filePath}`)
      fsyncSync(descriptor)
    } finally { closeSync(descriptor) }
    linkSync(temporary, filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}
