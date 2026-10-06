import { realPathOr, type UntrustedRoots } from '../../domain/executable.js'

/** Why every program is refused while the registry cannot be read (resolveProgram's `rootsUnknown`). */
export const REGISTRY_UNREADABLE = 'the workspace registry cannot be read: it could lie in a registered workspace, where an agent can write'

/**
 * Every root on this node no program Buckle runs may come from (resolveProgram), for every workspace alike: the
 * default workspace's root, each registered workspace's, each scratch root, and each mount's source, as named and
 * where each really is. One PATH serves them all, and `npx` or `pnpm exec` starts it at the default workspace's
 * `node_modules/.bin`, so a bwrap the default workspace's agent planted there was a registered workspace's sandbox.
 * Resolved once for the node; the registered roots are taken in again whenever the registry is read for a workspace,
 * and when one is registered.
 */
export interface NodeRoots {
  current(): Required<UntrustedRoots>
  /** The registered workspaces' roots, as the registry holds them now. */
  take(registered: readonly string[]): void
}

/**
 * `fixed` are the roots the node's configuration names. `readRegistered` reads the registered workspaces' roots, or
 * answers null when the registry cannot be read: every program is then refused, and the registry is read again at the
 * next resolution. `platform`: the host's unless a test imitates another.
 */
export function createNodeRoots(input: { fixed: readonly string[]; readRegistered: () => readonly string[] | null; platform?: NodeJS.Platform }): NodeRoots {
  const platform = input.platform ?? process.platform
  const spelled = (roots: readonly string[]): string[] => [...new Set(roots.flatMap(root => [root, realPathOr(root, platform)]))]
  let fixed: string[] | undefined
  let registered: string[] | null = null
  return {
    current() {
      fixed ??= spelled(input.fixed)
      if (registered === null) {
        const read = input.readRegistered()
        registered = read && spelled(read)
      }
      return { untrustedRoots: [...fixed, ...registered ?? []], rootsUnknown: registered === null ? REGISTRY_UNREADABLE : null }
    },
    take(roots) { registered = spelled(roots) },
  }
}
