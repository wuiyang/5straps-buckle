import { relative, resolve } from 'node:path'

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
  /** The virtual root, when the owner mounted the workspace. */
  readonly mount: string | null
  /** The workspace as the agent names it. */
  readonly displayRoot: string
  /** An input path, relative or virtual or real, as the real absolute path. */
  resolve(path: string): string
  /** A real path as the agent should read it: relative inside the workspace, otherwise as is. */
  display(real: string): string
  /** A real path in absolute agent-facing form. */
  toVirtual(real: string): string
}

export function createPathView(input: { root: string; mount: string | null }): PathView {
  const root = resolve(input.root)
  const mount = input.mount

  const insideMount = (path: string): string | null => {
    if (!mount) return null
    if (path === mount) return ''
    return path.startsWith(`${mount}/`) ? path.slice(mount.length + 1) : null
  }

  return {
    root,
    mount,
    displayRoot: mount ?? root,

    resolve(path) {
      const underMount = insideMount(path)
      if (underMount !== null) return resolve(root, underMount)
      return resolve(root, path)
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
      if (fromRoot.startsWith('..')) return real
      return `${mount}/${fromRoot}`
    },
  }
}
