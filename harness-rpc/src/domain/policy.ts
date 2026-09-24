import { createHash } from 'node:crypto'
import { destructivePatterns, emptyWorkspacePolicy, MountPathSchema, type WorkspacePolicy } from '@5straps/protocol'
import { compileCommandGlob, CommandGlobError, type CommandGlob } from './command-glob.js'
import { compileUrlPatterns, UrlPatternError, type UrlMatcher } from './url-pattern.js'

/**
 * The policy in the form the rules consume. Compiled once per load, so a bad pattern fails
 * at startup or at the setup face rather than on the call it would have judged.
 */
export interface CompiledPolicy {
  policy: WorkspacePolicy
  commands: { allow: CommandGlob[]; deny: CommandGlob[]; destructive: CommandGlob[] }
  /** Null when the owner set no approved list, which leaves the network rule to its defaults. */
  network: UrlMatcher | null
  mount: string | null
  /** Approved-list entries left out because the host grammar refuses them; see `compilePolicy`. */
  skipped: SkippedEntry[]
}

export interface SkippedEntry {
  entry: string
  reason: string
}

export class PolicyError extends Error {}
export class PolicyConflictError extends PolicyError {}
export function policyRevision(policy: WorkspacePolicy | null): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}

/** Mounting over one of these would hide the tools the sandbox needs to run anything. */
const RESERVED_MOUNTS = new Set([
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/nix', '/opt', '/proc', '/root', '/run',
  '/sbin', '/sys', '/tmp', '/usr', '/var',
])

/**
 * `tolerated` names the approved-list entries that were already in force before this compile, on
 * disk or in the environment. One of those the host grammar now refuses (`*.127.0.0.1`, written
 * before `BUCKLE-D18`) is skipped rather than stopping the node and every `buckle` command: it
 * covers nothing, and a list left empty that way still reaches nothing. A new entry is refused.
 */
export function compilePolicy(policy: WorkspacePolicy, options: { tolerated?: (entry: string) => boolean } = {}): CompiledPolicy {
  const skipped = refusedNetworkEntries(policy.network.allow).filter(item => options.tolerated?.(item.entry))
  const usable = policy.network.allow.filter(entry => !skipped.some(item => item.entry === entry))
  return {
    policy,
    commands: {
      allow: compileGlobs(policy.commands.allow),
      deny: compileGlobs(policy.commands.deny),
      destructive: compileGlobs(destructivePatterns(policy)),
    },
    network: policy.network.allow.length > 0 ? compileNetwork(usable) : null,
    mount: validateMount(policy.mount),
    skipped,
  }
}

/** Each approved-list entry the grammar refuses, with its reason, for loading and `buckle policy migrate`. */
export function refusedNetworkEntries(entries: string[]): SkippedEntry[] {
  return entries.flatMap(entry => {
    try {
      compileUrlPatterns([entry])
      return []
    } catch (error) {
      if (error instanceof UrlPatternError) return [{ entry, reason: error.message }]
      throw error
    }
  })
}

/**
 * Both sources are the owner's, so the effective policy is their union: every deny from either,
 * every allow from either, and the last mount named. A later policy never loosens an earlier deny.
 */
export function mergePolicies(...policies: Array<WorkspacePolicy | null>): WorkspacePolicy {
  const merged = emptyWorkspacePolicy()
  for (const policy of policies) {
    if (!policy) continue
    if (policy.tools) {
      const previous = merged.tools
      const currentAllow = policy.tools.allow
      const allow = previous?.allow === undefined ? currentAllow
        : currentAllow === undefined ? previous.allow : previous.allow.filter(name => currentAllow.includes(name))
      merged.tools = { ...(allow !== undefined ? { allow: unique(allow) } : {}), deny: unique([...previous?.deny ?? [], ...policy.tools.deny]) }
    }
    if (policy.filesystem) merged.filesystem = { rules: [...merged.filesystem?.rules ?? [], ...policy.filesystem.rules] }
    merged.commands.allow = unique([...merged.commands.allow, ...policy.commands.allow])
    merged.commands.deny = unique([...merged.commands.deny, ...policy.commands.deny])
    merged.commands.destructive = unique([...destructivePatterns(merged), ...destructivePatterns(policy)])
    merged.network.allow = unique([...merged.network.allow, ...policy.network.allow])
    if (policy.mount) merged.mount = policy.mount
    if (policy.updatedAt && (!merged.updatedAt || policy.updatedAt > merged.updatedAt)) merged.updatedAt = policy.updatedAt
  }
  return merged
}

export function isRestrictive(policy: WorkspacePolicy): boolean {
  return policy.tools?.allow !== undefined || Boolean(policy.tools?.deny.length)
    || Boolean(policy.filesystem?.rules.length)
    || policy.commands.allow.length > 0
    || policy.commands.deny.length > 0
    || destructivePatterns(policy).length > 0
    || policy.network.allow.length > 0
    || policy.mount !== null
}

function compileGlobs(sources: string[]): CommandGlob[] {
  return sources.map(source => {
    try {
      return compileCommandGlob(source)
    } catch (error) {
      if (error instanceof CommandGlobError) throw new PolicyError(`Invalid command pattern ${JSON.stringify(source)}: ${error.message}`)
      throw error
    }
  })
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
