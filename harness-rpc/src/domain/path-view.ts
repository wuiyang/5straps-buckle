import { relative, resolve } from 'node:path'
import { isInsideAny } from './paths.js'
import { ToolInputError } from './tool.js'

/** What a real path outside the workspace is called, so a mount never shows one through. */
export const OUTSIDE_PATH = '/outside-the-workspace'

/**
 * How the agent names paths versus where they really are. With a mount, the workspace root is
 * presented as `/workspace` (or whatever the owner chose) and nothing else of the host is named.
 * Without one, the real root shows through, as it always did.
 *
 * Every pack resolves input paths through here and shows output paths through here, so the
 * permission rules keep judging real, symlink-resolved paths while the agent sees one view.
 */
export interface PathView {
  /** The real workspace root. */
  readonly root: string
  /** Real directories reachable beside the root, named as they really are. */
  readonly scratchRoots: string[]
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
  /** A real path as the agent should read it: relative inside the workspace, otherwise as is. */
  display(real: string): string
  /** A real path in absolute agent-facing form, or `OUTSIDE_PATH` when a mount hides it. */
  toVirtual(real: string): string
}

export function createPathView(input: { root: string; mount: string | null; scratchRoots?: string[] }): PathView {
  const root = resolve(input.root)
  const mount = input.mount
  const scratchRoots = (input.scratchRoots ?? []).map(scratch => resolve(scratch))
  const reachable = [root, ...scratchRoots]
  const displayRoots = [mount ?? root, ...scratchRoots]

  const insideMount = (path: string): string | null => {
    if (!mount) return null
    if (path === mount) return ''
    return path.startsWith(`${mount}/`) ? path.slice(mount.length + 1) : null
  }

  return {
    root,
    scratchRoots,
    mount,
    displayRoot: mount ?? root,
    displayRoots,

    resolve(path) {
      const underMount = insideMount(path)
      const real = underMount === null ? resolve(root, path) : resolve(root, underMount)
      if (!mount || isInsideAny(reachable, real)) return real
      throw new ToolInputError(outsideMountReason({ named: path, displayRoots }), { code: 'PERMISSION_DENIED' })
    },

    display(real) {
      const fromRoot = relative(root, real)
      if (fromRoot === '') return '.'
      return fromRoot.startsWith('..') ? real : fromRoot
    },

    toVirtual(real) {
      if (!mount) return real
      const fromRoot = relative(root, real)
      if (fromRoot === '') return mount
      if (!fromRoot.startsWith('..')) return `${mount}/${fromRoot}`
      return isInsideAny(scratchRoots, real) ? real : OUTSIDE_PATH
    },
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
