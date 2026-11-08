import { realpathSync, statSync } from 'node:fs'
import { dirname } from 'pathe'
import { protectedStateRoots, type NodeConfig } from '../../runtime/config.js'
import { MAX_OWNER_MOUNTS, mountTargetRefusal, SYSTEM_PROGRAM_FOLDERS, type OwnerMount } from '../../domain/mount-table.js'
import { ignoresCase, isDriveRoot, isInsideComparable, nativePath, shareRoot, typedShare, WHOLE_DRIVE } from '../../domain/paths.js'
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
  return [...node.mountReadOnlyPaths, ...shared, dirname(dirname(process.execPath)), ...SYSTEM_PROGRAM_FOLDERS]
    .map(path => { try { return nativePath(realpathSync.native(path)) } catch { return path } })
}

/**
 * A mount's source as the disk names it (Phase 2 item 1): links followed, in the case the disk stores, an existing
 * folder or file. On Windows a share is taken as a source, and a mapped drive is stored as the share it points to, as
 * the system resolves it (Q8): a node started at login by another logon does not see the letter. A device path
 * (`\\?\`, `\\.\`) is refused, as typed or as the system answers, and so is a whole drive. `typed` is absolute;
 * `stored` stands for the system's resolution where a test imitates Windows.
 */
export function canonicalMountSource(typed: string, platform: NodeJS.Platform, stored: (path: string) => string = path => realpathSync.native(path)): string {
  const sharesOf = (path: string) => (platform === 'win32' ? typedShare(path) : [])
  try { nativePath(typed, platform, sharesOf(typed)) } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : String(error)) }
  refuseWholeDrive(typed, platform)
  let canonical: string
  try { canonical = stored(typed) } catch { throw new WorkspaceError(MISSING_SOURCE) }
  let named: string
  try { named = nativePath(canonical, platform, sharesOf(canonical)) } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : String(error)) }
  if (isDriveRoot(named, platform) || shareRoot(named) === named) throw new WorkspaceError(`A mount's source ${named}: ${WHOLE_DRIVE}`)
  try {
    const info = statSync(named)
    if (!info.isDirectory() && !info.isFile()) throw new Error('Not a folder or file')
  } catch { throw new WorkspaceError(MISSING_SOURCE) }
  return named
}

const MISSING_SOURCE = 'A mount\'s source must be an existing folder or file'

/**
 * What one of the owner's mounts is checked against on its node (Phase 2 item 1): the places of Buckle's state no
 * source may reach, the folders every sandbox runs programs from, which no writable source may reach, and the
 * toolchain paths the sandbox binds at their own path, which no target may overlap. `storedPath` stands for the
 * system's resolution where a test imitates Windows.
 */
export interface MountGuards {
  readonly state: readonly string[]
  readonly exposed: readonly string[]
  readonly fixed: readonly string[]
  readonly platform: NodeJS.Platform
  readonly storedPath?: (path: string) => string
}

/** A node's mount guards; `stateRoot` is its state directory as the disk names it, where it exists already. */
export function mountGuardsOf(node: NodeConfig, platform: NodeJS.Platform, extra: { stateRoot?: string; storedPath?: (path: string) => string } = {}): MountGuards {
  return {
    state: [...(extra.stateRoot === undefined ? [] : [extra.stateRoot]), ...protectedStateRoots(node)],
    exposed: exposedRoots(node),
    fixed: [...node.mountReadOnlyPaths, dirname(dirname(process.execPath))],
    platform,
    ...(extra.storedPath ? { storedPath: extra.storedPath } : {}),
  }
}

/**
 * A mount's source as `buckle workspace mount add` checks it: as the disk names it (canonicalMountSource), refused where
 * it holds, or sits inside, Buckle's state or the workspace's folder `dir`, or, writable, a folder every sandbox runs
 * programs from. Answers the mount with its source as stored. Throws WorkspaceError.
 */
export function checkedMountSource(mount: OwnerMount, input: { dir: string; guards: MountGuards }): OwnerMount {
  const { guards } = input
  const source = canonicalMountSource(mount.source, guards.platform, guards.storedPath)
  const meets = (other: string) => overlaps(other, source, guards.platform)
  if (guards.state.some(meets)) throw new WorkspaceError('A mount\'s source must not hold, or sit inside, Buckle\'s state', 409)
  if (meets(input.dir)) throw new WorkspaceError('A mount\'s source must not hold, or sit inside, the workspace\'s own folder, which shows at its own target', 409)
  if (mount.access === 'rw' && guards.exposed.some(meets)) throw new WorkspaceError('A writable mount\'s source must not hold, or sit inside, a folder every sandbox runs programs from (a system folder, the Node install, or a toolchain the node names); share it read-only with :ro', 409)
  return { source, target: mount.target, access: mount.access }
}

/**
 * Refuses a mount, its source as stored, joining the mounts `owners` of a workspace whose folder shows at `folder`, as
 * `buckle workspace mount add` refuses one: at a target one of them holds, past the 32 a workspace holds, over another's
 * source, or at a target taken or kept (mountTargetRefusal). Throws WorkspaceError.
 */
export function refuseMountJoining(added: OwnerMount, input: { folder: string | null; owners: readonly OwnerMount[]; guards: MountGuards }): void {
  const { owners, guards } = input
  if (owners.some(owner => owner.target === added.target)) throw new WorkspaceError(`A mount already shows at ${added.target}; remove it first with buckle workspace mount remove ${added.target}`, 409)
  // The folder's own entry is no part of the count; the settings schema keeps the bound for a file edited by hand.
  if (owners.length >= MAX_OWNER_MOUNTS) throw new WorkspaceError(`A workspace holds at most ${MAX_OWNER_MOUNTS} mounts of its own, not counting its folder; remove one first with buckle workspace mount remove <sandbox-path>`, 409)
  const shared = owners.find(owner => overlaps(owner.source, added.source, guards.platform))
  if (shared) throw new WorkspaceError(`That source holds, or sits inside, the source of the mount at ${shared.target}`, 409)
  const refusal = mountTargetRefusal(added.target, { folder: input.folder, others: owners.map(owner => owner.target), fixed: guards.fixed })
  if (refusal) throw new WorkspaceError(refusal)
}

export function assertNoHostExposure(root: string, exposed: readonly string[], platform: NodeJS.Platform): void {
  if (exposed.some(path => overlaps(path, root, platform))) {
    throw new WorkspaceError('Workspace overlaps a host toolchain or read-only mount; narrow the host exposure first', 409)
  }
}
