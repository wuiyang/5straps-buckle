import { createHash } from 'node:crypto'
import { allowedInterpreters, destructivePatterns, emptyWorkspacePolicy, MountPathSchema, type WorkspacePolicy } from '@5straps/protocol'
import { isInterpreter } from './command-forms.js'
import { compileCommandGlob, CommandGlobError, type CommandGlob } from './command-glob.js'
import { compileUrlPatterns, UrlPatternError, type UrlMatcher } from './url-pattern.js'
import type { ServiceFailure } from '../types/service-failure.js'

/**
 * The policy in the form the rules consume. Compiled once per load, so a bad pattern fails
 * at startup or at the setup face rather than on the call it would have judged.
 */
export interface CompiledPolicy {
  policy: WorkspacePolicy
  /** `allowedInterpreters`: the interpreters read as ordinary commands; every other one runs code Buckle reads as unknown (owner decision D55). */
  commands: { allow: CommandGlob[]; deny: CommandGlob[]; destructive: CommandGlob[]; allowedInterpreters: ReadonlySet<string> }
  /** Null when the owner set no approved list, which leaves the network rule to its defaults. */
  network: UrlMatcher | null
  mount: string | null
}

export interface RefusedEntry {
  entry: string
  reason: string
}

/** A policy the node refuses: HTTP 400. */
export class PolicyError extends Error implements ServiceFailure {
  readonly code: string = 'POLICY_INVALID'
  readonly status: number = 400
}
/** A policy written against a revision that has since changed: HTTP 409. */
export class PolicyConflictError extends PolicyError {
  override readonly code = 'POLICY_CONFLICT'
  override readonly status = 409
}

/**
 * A policy document that names the dangerously-allow switch: HTTP 409 on PUT and registration, the
 * same refusal (exit 2) from `buckle policy import` (ruling H1e). The switch is not part of a policy
 * (review H1 of B20-B22); only its own local command changes it.
 */
export class DangerouslyAllowLocalOnlyError extends PolicyError {
  override readonly code = 'POLICY_DANGEROUSLY_ALLOW_LOCAL_ONLY'
  override readonly status = 409
  constructor() {
    super('The dangerously-allow switch is not part of a workspace policy and changes only through the owner\'s local CLI: buckle policy dangerously-allow on|off')
  }
}

/** Refuses a policy document, as it arrived, that names the switch; parsing would otherwise drop the field without a word. */
export function refuseSwitchIn(document: unknown): void {
  if (typeof document === 'object' && document !== null && Object.hasOwn(document, 'dangerouslyAllow')) throw new DangerouslyAllowLocalOnlyError()
}

/** The stored policy stops the node from loading; the message names the file, what it refuses and the repair. */
export class StoredPolicyError extends PolicyError {
  constructor(input: { file: string; reason: string; stored: WorkspacePolicy; environment: WorkspacePolicy }) {
    super(storedPolicyMessage(input))
  }
}

function storedPolicyMessage(input: { file: string; reason: string; stored: WorkspacePolicy; environment: WorkspacePolicy }): string {
  const refused = refusedNetworkEntries(input.stored.network.allow).map(item => item.entry)
  const repair = refused.length
    ? refused.map(entry => `\`buckle policy remove ${entry}\``).join(', then ')
    : '`buckle policy remove <pattern>` for the refused pattern'
  const emptiesList = refused.length > 0 && refused.length === input.stored.network.allow.length && input.environment.network.allow.length === 0
  return [
    `Stored policy in ${input.file} cannot load: ${input.reason}.`,
    `Repair it with ${repair}, or drop it with \`buckle policy clear\`; until it loads only \`buckle policy show|export|remove|clear\` run.`,
    ...(emptiesList ? ['Those entries are the whole approved list, and an empty approved list is no list: the default network rules then reach public hosts. Add an entry with `buckle policy allow-url <host>` once it loads.'] : []),
  ].join(' ')
}
export function policyRevision(policy: WorkspacePolicy | null): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}

/** Mounting over one of these would hide the tools the sandbox needs to run anything. */
const RESERVED_MOUNTS = new Set([
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/nix', '/opt', '/proc', '/root', '/run',
  '/sbin', '/sys', '/tmp', '/usr', '/var',
])

export function compilePolicy(policy: WorkspacePolicy): CompiledPolicy {
  return {
    policy,
    commands: {
      allow: compileGlobs(policy.commands.allow),
      deny: compileGlobs(policy.commands.deny),
      destructive: compileGlobs(destructivePatterns(policy)),
      allowedInterpreters: compileInterpreters(allowedInterpreters(policy)),
    },
    network: policy.network.allow.length > 0 ? compileNetwork(policy.network.allow) : null,
    mount: validateMount(policy.mount),
  }
}

/** Each approved-list entry the grammar refuses, with its reason. */
export function refusedNetworkEntries(entries: string[]): RefusedEntry[] {
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
    const interpreters = unique([...allowedInterpreters(merged), ...allowedInterpreters(policy)])
    if (interpreters.length > 0) merged.commands.allowedInterpreters = interpreters
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

/** The interpreter names a policy allows, each one Buckle knows as an interpreter, so a typo never stands for one. */
function compileInterpreters(names: string[]): ReadonlySet<string> {
  for (const name of names) {
    if (!isInterpreter(name)) throw new PolicyError(`Invalid interpreter ${JSON.stringify(name)}: python, node, nodejs, deno, bun, perl, ruby, or php, with a version where the program has one (python3.12)`)
  }
  return new Set(names)
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
