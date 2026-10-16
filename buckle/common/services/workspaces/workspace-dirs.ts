import { realpathSync, statSync } from 'node:fs'
import { dirname } from 'pathe'
import type { NodeConfig } from '../../runtime/config.js'
import { ignoresCase, isDriveRoot, isInsideComparable, nativePath, WHOLE_DRIVE } from '../../domain/paths.js'
import { WorkspaceError } from './registry.js'

/**
 * An existing directory as the disk names it: links followed, in the case the disk stores. On Windows a whole drive is
 * refused, as named and where it really is: every file on it would be the workspace's.
 */
export function canonicalDirectory(root: string, platform: NodeJS.Platform): string {
  refuseWholeDrive(root, platform)
  let canonical: string
  try {
    canonical = realpathSync.native(root)
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory')
  } catch { throw new WorkspaceError('Workspace folder must be an existing directory') }
  let named: string
  try { named = nativePath(canonical) } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : String(error)) }
  return refuseWholeDrive(named, platform)
}

function refuseWholeDrive(root: string, platform: NodeJS.Platform): string {
  if (isDriveRoot(root, platform)) throw new WorkspaceError(`Workspace folder ${root}: ${WHOLE_DRIVE}`)
  return root
}

/** Whether either folder holds the other, as the volume compares paths (a case variant of a folder is that folder on macOS). */
export function overlaps(left: string, right: string, platform: NodeJS.Platform): boolean {
  return isInsideComparable(left, right, ignoresCase(platform), platform) || isInsideComparable(right, left, ignoresCase(platform), platform)
}

/** The host folders every sandbox shares read-only, which no workspace may hold or sit inside: toolchains and the node's read-only mounts. */
export function exposedRoots(node: Pick<NodeConfig, 'mountReadOnlyPaths' | 'workspaceDefaults'>): string[] {
  const shared = (node.workspaceDefaults.mounts ?? []).filter(mount => mount.access === 'ro').map(mount => mount.source)
  return [...node.mountReadOnlyPaths, ...shared, dirname(dirname(process.execPath)), '/usr', '/bin', '/sbin', '/lib', '/lib64']
    .map(path => { try { return nativePath(realpathSync.native(path)) } catch { return path } })
}

export function assertNoHostExposure(root: string, exposed: readonly string[], platform: NodeJS.Platform): void {
  if (exposed.some(path => overlaps(path, root, platform))) {
    throw new WorkspaceError('Workspace overlaps a host toolchain or read-only mount; narrow the host exposure first', 409)
  }
}
