import { ownRoots, realPathOr, type UntrustedRoot, type UntrustedRoots } from '../../domain/executable.js'

/** Why every program is refused while the registry cannot be read (resolveProgram's `rootsUnknown`). */
export const REGISTRY_UNREADABLE = 'the workspace registry cannot be read: it could lie in a registered workspace, where an agent can write'

/** Why every program is refused while a workspace's settings cannot be read: no name or path, as an agent may read it. */
export const MOUNTS_UNREADABLE = 'a workspace\'s settings cannot be read: it could lie in a folder that workspace mounts writable, where an agent can write'

/**
 * Every root on this node no program Buckle runs may come from (resolveProgram), for every workspace alike: each
 * registered workspace's folder, each scratch root, and the source of each mount any workspace shares writable, as
 * named and where each really is. A source mounted read-only is no such root, as no agent writes it, any more than a
 * BUCKLE_MOUNT_READ_ONLY folder. One PATH serves them all, and `npx` or `pnpm exec` starts it at one workspace's
 * `node_modules/.bin`, so a bwrap one workspace's agent planted there was another workspace's sandbox. Resolved once for
 * the node; the registered roots are taken in again whenever the registry is read for a workspace, and when one is
 * registered or its mounts change.
 */
export interface NodeRoots {
  current(): Required<UntrustedRoots>
  /** The registered workspaces' roots, their folders and writable mounts, as the registry and their settings hold them now; or why they are unknown. */
  take(registered: readonly UntrustedRoot[] | string): void
}

/**
 * Where no program a workspace runs may come from: its own root and scratch roots, and every root the node knows, read
 * at each resolution. The workspace runtime and `buckle init` both resolve by it, so init reports a program the node
 * refuses as refused (review of 2026-10-14).
 */
export function workspaceUntrusted(view: { root: string; scratchRoots: readonly string[] }, nodeRoots?: NodeRoots): UntrustedRoots {
  const node = nodeRoots?.current()
  return { untrustedRoots: [...ownRoots(view).untrustedRoots, ...node?.untrustedRoots ?? []], rootsUnknown: node?.rootsUnknown ?? null }
}

/**
 * `fixed` are the roots the node's configuration names. `readRegistered` reads the registered workspaces' roots, or
 * answers why they cannot be read (the registry, or a workspace's settings, will not read): every program is then
 * refused, and they are read again at the next resolution. `platform`: the host's unless a test imitates another.
 */
export function createNodeRoots(input: { fixed: readonly UntrustedRoot[]; readRegistered: () => readonly UntrustedRoot[] | string; platform?: NodeJS.Platform }): NodeRoots {
  const platform = input.platform ?? process.platform
  const spelled = (roots: readonly UntrustedRoot[]): UntrustedRoot[] => {
    const all = roots.flatMap(root => [root, { ...root, path: realPathOr(root.path, platform) }])
    return all.filter((root, index) => all.findIndex(other => other.path === root.path) === index)
  }
  let fixed: UntrustedRoot[] | undefined
  let registered: UntrustedRoot[] | string | null = null
  const taken = (roots: readonly UntrustedRoot[] | string) => (typeof roots === 'string' ? roots : spelled(roots))
  return {
    current() {
      fixed ??= spelled(input.fixed)
      // Unknown is read again at each resolution, so a repaired registry or settings file is taken up.
      if (registered === null || typeof registered === 'string') registered = taken(input.readRegistered())
      return typeof registered === 'string' ? { untrustedRoots: fixed, rootsUnknown: registered } : { untrustedRoots: [...fixed, ...registered], rootsUnknown: null }
    },
    take(roots) { registered = taken(roots) },
  }
}
