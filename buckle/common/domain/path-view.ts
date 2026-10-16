import { posix, relative } from 'pathe'
import type { MountAccess, TableMount } from './mount-table.js'
import { isInside, isInsideAny, nativePath, refuseDrive, resolvePath, shareRoot } from './paths.js'
import { ToolInputError } from './tool.js'

/** What a real path outside the workspace is called, so a mount never shows one through. */
export const OUTSIDE_PATH = '/outside-the-workspace'

/**
 * One mount as the agent's view holds it (Phase 2 item 2): a real folder or file, `source`, the agent names at
 * `target`, read and write or read only. A scratch root is named by its real path, as it always was.
 */
export interface ViewMount {
  readonly source: string
  readonly target: string
  readonly access: MountAccess
  readonly scratch: boolean
  /** One of the node's BUCKLE_MOUNTS, so a refusal names the command that changes it. */
  readonly node?: true
}

/**
 * How the agent names paths versus where they really are. With a mount, the workspace root is presented as
 * `/workspace` (or whatever the owner chose), each of the owner's mounts at its own target, and nothing else of the
 * host is named. Without one, the real root shows through, as it always did, with the scratch roots beside it; the
 * owner's other mounts are then the shell's alone, as the explicit mounts were.
 *
 * Every pack resolves input paths through here and shows output paths through here, so the permission rules keep
 * judging real, symlink-resolved paths while the agent sees one view.
 */
export interface PathView {
  /** The real workspace root. */
  readonly root: string
  /** The mounts this view reaches, each at its target. */
  readonly mounts: readonly ViewMount[]
  /** Real directories writable without asking, named as they really are. */
  readonly scratchRoots: string[]
  /** Every real place the agent may name: the root and each mount's source. */
  readonly reachableRoots: string[]
  /**
   * On Windows, the sources of mounts that lie on a network share (D84 (1), Q8): a path on a share is read only where
   * one of these holds it (nativePath), and refused everywhere else, as in 0.1.5. Empty elsewhere.
   */
  readonly shares: string[]
  /** The virtual root, when the owner mounted the workspace. */
  readonly mount: string | null
  /** The workspace as the agent names it. */
  readonly displayRoot: string
  /** Every root the agent may name, as it names them. */
  readonly displayRoots: string[]
  /**
   * An input path, relative or virtual or real, as the real absolute path. Under a mount a path
   * landing outside the reachable roots is refused here rather than resolved.
   */
  resolve(path: string): string
  /** A real path as the agent should read it: relative inside the workspace, otherwise as `toVirtual` names it. */
  display(real: string): string
  /** A real path in absolute agent-facing form, or `OUTSIDE_PATH` when a mount hides it. */
  toVirtual(real: string): string
  /** The mount a real path lies in, or null where it lies in the root or nowhere the view reaches. */
  mountOf(real: string): ViewMount | null
  /** Whether a string names the folder or a mount by its sandbox path, as a tool's argument may. */
  namesVirtual(path: string): boolean
}

/**
 * `platform` is the host's unless a test imitates another: on Windows the agent's backslashes are separators, and on
 * Linux and macOS, where a backslash is part of a name, a path holding one is refused (withForwardSlashes) rather than
 * read as another path. A tool that hands the agent's string to another program (git, a shell) would otherwise reach
 * the name while the rules judged the path pathe reads. So is a path that pathe folds or resolves onto a drive there
 * (`./C:/x`, `../C:/x`) or onto a root folder named like one (`../../c:` from two levels down), and `//x` is `/x`, as
 * the kernel reads both (nativePath, refuseDrive). On Windows a climb stops at the drive's root (resolvePath).
 *
 * `mounts` is the mount table in force; `scratchRoots`, the older spelling, are scratch mounts at their own path.
 */
export function createPathView(input: { root: string; mount: string | null; mounts?: readonly TableMount[]; scratchRoots?: string[]; platform?: NodeJS.Platform }): PathView {
  const root = resolvePath(input.root)
  const mount = input.mount
  const table: TableMount[] = [...input.mounts ?? [], ...(input.scratchRoots ?? []).map((path): TableMount => ({ source: path, target: path, access: 'rw', scratch: true }))]
  // Unmounted, a scratch root is named by its real path and reached; the owner's other mounts have no name in a real view.
  const onShares = input.platform === 'win32' || (input.platform === undefined && process.platform === 'win32')
  // A source on a share is kept as stored: pathe's resolve would read `//server/share` as a folder on the current drive.
  const sourceOf = (path: string) => (onShares && shareRoot(path) !== null ? path : resolvePath(path))
  const mounts: ViewMount[] = table
    .filter(entry => mount !== null || entry.scratch)
    .map(entry => ({ source: sourceOf(entry.source), target: entry.scratch ? sourceOf(entry.source) : entry.target, access: entry.access, scratch: entry.scratch === true, ...(entry.node ? { node: true as const } : {}) }))
  const shares = onShares ? mounts.map(entry => entry.source).filter(source => shareRoot(source) !== null) : []
  const named = mounts.filter(entry => !entry.scratch)
  const scratchRoots = mounts.filter(entry => entry.scratch).map(entry => entry.source)
  const reachable = [root, ...mounts.map(entry => entry.source)]
  const displayRoots = [mount ?? root, ...mounts.map(entry => entry.target)]

  const beneath = (target: string, path: string): string | null => {
    if (path === target) return ''
    return path.startsWith(`${target}/`) ? path.slice(target.length + 1) : null
  }

  const mountOf = (real: string): ViewMount | null => mounts.find(entry => isInside(entry.source, real, input.platform)) ?? null

  const toVirtual = (real: string): string => {
    if (!mount) return real
    if (isInside(root, real, input.platform)) {
      const fromRoot = relative(root, real)
      return fromRoot === '' ? mount : `${mount}/${fromRoot}`
    }
    const holder = mountOf(real)
    if (!holder) return OUTSIDE_PATH
    if (holder.scratch) return real
    // On a share, the rest is the path's own text after the source, as mountOf found it there: pathe's relative would
    // read both as folders on the current drive.
    const below = shares.includes(holder.source) ? real.slice(holder.source.length).replace(/^\/+/, '') : relative(holder.source, real)
    return below === '' ? holder.target : `${holder.target}/${below}`
  }

  /**
   * A typed path, in pathe's form, as the real path it names: under a mount's target, beneath that mount's source (the
   * rest was folded by nativePath, so it never climbs out); under the folder's, beneath the root; anything else as it is,
   * a relative one from the root.
   */
  const realOf = (typed: string): string => {
    if (mount) {
      for (const entry of named) {
        const below = beneath(entry.target, typed)
        if (below === null) continue
        if (below === '') return entry.source
        return shareRoot(entry.source) !== null && shares.includes(entry.source) ? `${entry.source}/${posix.normalize(below)}` : resolvePath(entry.source, posix.normalize(below))
      }
      const underFolder = beneath(mount, typed)
      if (underFolder !== null) return resolvePath(root, underFolder)
    }
    // A path on a share the view reaches is real as typed (nativePath folded it beneath its share).
    return shares.length > 0 && shareRoot(typed) !== null ? typed : resolvePath(root, typed)
  }

  return {
    root,
    mounts,
    scratchRoots,
    reachableRoots: reachable,
    shares,
    mount,
    displayRoot: mount ?? root,
    displayRoots,

    resolve(path) {
      const real = refuseDrive(realOf(nativePath(path, input.platform, shares)), path, input.platform)
      if (!mount || isInsideAny(reachable, real, input.platform)) return real
      throw new ToolInputError(outsideMountReason({ named: path, displayRoots }), { code: 'PERMISSION_DENIED' })
    },

    display(real) {
      if (!isInside(root, real, input.platform)) return toVirtual(real)
      const fromRoot = relative(root, real)
      return fromRoot === '' ? '.' : fromRoot
    },

    toVirtual,
    mountOf,
    namesVirtual: path => mount !== null && [mount, ...named.map(entry => entry.target)].some(target => beneath(target, path) !== null),
  }
}

/**
 * Why a mounted workspace refuses a path. `named` is the agent's own string; null when the path
 * only left the workspace once symlinks were resolved, because the real path it landed on is
 * exactly what the mount exists to withhold.
 */
export function outsideMountReason(input: { named: string | null; displayRoots: string[] }): string {
  const subject = input.named ?? 'That path'
  return `${subject} is outside the mounted workspace, which is a boundary rather than a question: it is refused, not asked. Reachable: ${input.displayRoots.join(', ')}`
}

/** Why a write into a read-only mount is refused: the owner shared it to read, which no approval changes (Q6). */
export function readOnlyMountReason(shown: string): string {
  return `${shown} is in a mount the owner shares read-only, which is a boundary rather than a question: it is refused, not asked`
}
