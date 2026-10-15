import { createHash } from 'node:crypto'

/** The namespace Buckle derives workspace ids in: one fixed UUID, so the same folder always derives the same id. */
const WORKSPACE_NAMESPACE = Buffer.from('6f3a1c2e8b4d4f0a9c7e2d5b1a8f3c6e', 'hex')

const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A workspace's id (D85, Q15): a UUID Buckle assigns, which nobody types, so two workspaces never conflict on it. It is
 * derived from the folder as the disk names it (UUID version 5 over a fixed namespace), so a node moved onto workspaces
 * derives the same ids on every run of the move, and a folder registered again after a remove finds its records.
 */
export function workspaceIdFor(dir: string): string {
  const digest = createHash('sha1').update(WORKSPACE_NAMESPACE).update(dir, 'utf8').digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Whether a handle has a UUID's form: a name may not, so `--workspace` reads each unambiguously. */
export function looksLikeWorkspaceId(handle: string): boolean {
  return UUID_FORM.test(handle)
}
