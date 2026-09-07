import { emptyWorkspacePolicy, MountPathSchema, type WorkspacePolicy } from '@5straps/protocol'
import { compileUrlPatterns, UrlPatternError, type UrlMatcher } from './url-pattern.js'

/**
 * The policy in the form the rules consume. Compiled once per load, so a bad pattern fails
 * at startup or at the setup face rather than on the call it would have judged.
 */
export interface CompiledPolicy {
  policy: WorkspacePolicy
  commands: { allow: RegExp[]; deny: RegExp[] }
  /** Null when the owner set no approved list, which leaves the network rule to its defaults. */
  network: UrlMatcher | null
  mount: string | null
}

export class PolicyError extends Error {}

/** Mounting over one of these would hide the tools the sandbox needs to run anything. */
const RESERVED_MOUNTS = new Set([
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/nix', '/opt', '/proc', '/root', '/run',
  '/sbin', '/sys', '/tmp', '/usr', '/var',
])

export function compilePolicy(policy: WorkspacePolicy): CompiledPolicy {
  return {
    policy,
    commands: {
      allow: policy.commands.allow.map(compileRegExp),
      deny: policy.commands.deny.map(compileRegExp),
    },
    network: policy.network.allow.length > 0 ? compileNetwork(policy.network.allow) : null,
    mount: validateMount(policy.mount),
  }
}

/**
 * Both sources are the owner's, so the effective policy is their union: every deny from either,
 * every allow from either, and the last mount named. A later policy never loosens an earlier deny.
 */
export function mergePolicies(...policies: Array<WorkspacePolicy | null>): WorkspacePolicy {
  const merged = emptyWorkspacePolicy()
  for (const policy of policies) {
    if (!policy) continue
    merged.commands.allow = unique([...merged.commands.allow, ...policy.commands.allow])
    merged.commands.deny = unique([...merged.commands.deny, ...policy.commands.deny])
    merged.network.allow = unique([...merged.network.allow, ...policy.network.allow])
    if (policy.mount) merged.mount = policy.mount
    if (policy.updatedAt && (!merged.updatedAt || policy.updatedAt > merged.updatedAt)) merged.updatedAt = policy.updatedAt
  }
  return merged
}

export function isRestrictive(policy: WorkspacePolicy): boolean {
  return policy.commands.allow.length > 0
    || policy.commands.deny.length > 0
    || policy.network.allow.length > 0
    || policy.mount !== null
}

function compileRegExp(source: string): RegExp {
  try {
    return new RegExp(source)
  } catch (error) {
    throw new PolicyError(`Invalid command pattern ${JSON.stringify(source)}: ${error instanceof Error ? error.message : 'bad regular expression'}`)
  }
}

function compileNetwork(patterns: string[]): UrlMatcher {
  try {
    return compileUrlPatterns(patterns)
  } catch (error) {
    if (error instanceof UrlPatternError) throw new PolicyError(error.message)
    throw error
  }
}

function validateMount(mount: string | null): string | null {
  if (mount === null) return null
  const parsed = MountPathSchema.safeParse(mount)
  if (!parsed.success) throw new PolicyError(`Invalid mount path ${JSON.stringify(mount)}: an absolute path with plain segments, e.g. /workspace`)
  const top = `/${mount.split('/')[1] ?? ''}`
  if (RESERVED_MOUNTS.has(top)) throw new PolicyError(`Cannot mount the workspace under ${top}: the sandbox needs it for the host's own tools`)
  return mount
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))]
}
