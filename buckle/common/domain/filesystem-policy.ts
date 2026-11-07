import { realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { relative } from 'pathe'
import type { FilesystemPermission, WorkspacePolicy } from '@5straps/protocol'
import { childPath, comparablePath, isInside, isInsideComparable, nativePath, parentDirectory, resolvePath } from './paths.js'
import type { PermissionRule } from './permission/decision.js'
import { allowedVia, ask, deny, PLAIN_MARKS } from './permission/decision.js'

export interface FilesystemPolicyInput {
  path: string
  operation: 'read' | 'write'
  policy: WorkspacePolicy
  /** Whether the volume ignores case; the platform's default (comparablePath) when absent. */
  caseInsensitive?: boolean
  /** The host's unless a test imitates another: off Windows a rule's names are names under the root (rulePath). */
  platform?: NodeJS.Platform
}
export type FilesystemDecision = FilesystemPermission | 'inherit'

export function resolveFilesystemPermission(input: FilesystemPolicyInput): FilesystemDecision {
  return matchRules(input.policy, input)
}

export function resolveFilesystemAccess(input: Omit<FilesystemPolicyInput, 'operation'>) {
  const read = resolveFilesystemPermission({ ...input, operation: 'read' })
  const write = resolveFilesystemPermission({ ...input, operation: 'write' })
  return { read: read === 'inherit' ? 'allow' as const : read, write: write === 'inherit' ? 'ask' as const : write }
}

/**
 * The rules that cover a relative path. A restriction (deny or ask) covers every spelling the volume
 * treats as its path, so `SECRETS/new.json` meets a `secrets` deny on macOS (review H2 of the second
 * proof-of-possession re-review); an allow covers its own spelling only, so on a case-sensitive
 * volume a sibling directory is never allowed by another's rule.
 */
function matchRules(policy: WorkspacePolicy, input: Pick<FilesystemPolicyInput, 'path' | 'operation' | 'caseInsensitive'>): FilesystemDecision {
  const { path, operation } = input
  const fold = (value: string) => comparablePath(value, input.caseInsensitive)
  const covers = (rulePath: string, candidate: string) => rulePath === '.' || candidate === rulePath || candidate.startsWith(`${rulePath}/`)
  const matching = (policy.filesystem?.rules ?? []).filter(rule => rule[operation] === 'allow' ? covers(rule.path, path) : covers(fold(rule.path), fold(path)))
  if (matching.some(rule => rule[operation] === 'deny')) return 'deny'
  return matching.filter(rule => rule[operation] !== undefined).sort((a, b) => b.path.length - a.path.length)[0]?.[operation] ?? 'inherit'
}

export function filesystemPathDecision(input: Omit<FilesystemPolicyInput, 'path'> & { root: string; path: string }): FilesystemDecision {
  const platform = input.platform ?? process.platform
  const path = relativeWithin(input.root, input.path, input.caseInsensitive, platform)
  if (path === null) return 'inherit'
  const canonical = (policy: WorkspacePolicy): WorkspacePolicy => ({ ...policy, filesystem: { rules: (policy.filesystem?.rules ?? []).flatMap(rule => {
    const target = relativeWithin(input.root, canonicalPolicyPath(rulePath(input.root, rule.path, platform), platform), input.caseInsensitive, platform)
    return target === null ? [rule] : [rule, { ...rule, path: target }]
  }) } })
  return resolveFilesystemPermission({ ...input, policy: canonical(input.policy), path })
}

/**
 * A path relative to the root, with `/` separators: in its own spelling when it sits inside the root
 * as written, folded when only a volume that ignores case puts it there (so restrictions still meet
 * it), null outside.
 */
function relativeWithin(root: string, path: string, caseInsensitive: boolean | undefined, platform: NodeJS.Platform): string | null {
  const within = (from: string, to: string) => relative(from, to).split('\\').join('/') || '.'
  if (isInside(root, path, platform)) return within(root, path)
  if (!isInsideComparable(root, path, caseInsensitive, platform)) return null
  return within(comparablePath(root, caseInsensitive), comparablePath(path, caseInsensitive))
}

export function createFilesystemPolicyRule(input: { root: string; policy: WorkspacePolicy; caseInsensitive?: boolean; platform?: NodeJS.Platform }): PermissionRule {
  return {
    id: 'filesystem_policy',
    evaluate({ effect, grants }) {
      // A secret file a reference names is read, by Buckle, as any read of it is judged (docs/user/how-to/secrets.md).
      if (effect.kind !== 'read_path' && effect.kind !== 'write_path' && effect.kind !== 'delete_path' && effect.kind !== 'secret_file') return null
      // A delete is a write; a folder removed or moved whole meets a rule on any path beneath it too.
      const operation = effect.kind === 'write_path' || effect.kind === 'delete_path' ? 'write' : 'read'
      const own = filesystemPathDecision({ ...input, path: effect.path, operation })
      const verdicts = [{ operation: operation as 'read' | 'write', decision: own }]
      // Removed whole, the folder takes the paths beneath it with it; landed whole, it puts them where its landing names them.
      if (effect.kind === 'delete_path' || (effect.kind === 'write_path' && effect.folder)) verdicts.push({ operation: 'write', decision: restrictionBeneath({ ...input, path: effect.path, operation: 'write' }) ?? 'inherit' })
      // Moved whole, it takes them out from under a rule that read-denied or read-asked them where they stood.
      if (effect.kind === 'delete_path' && effect.moved) verdicts.push({ operation: 'read', decision: restrictionBeneath({ ...input, path: effect.path, operation: 'read' }) ?? 'inherit' })
      const denied = verdicts.find(verdict => verdict.decision === 'deny')
      if (denied) return deny('filesystem_policy', `${denied.operation}:${effect.path}`, `Workspace policy denies ${denied.operation} access`)
      const asked = verdicts.find(verdict => verdict.decision === 'ask')
      if (!asked) return null
      const subject = `${asked.operation}:${effect.path}`
      if (grants.subjectsFor('filesystem_policy').includes(subject)) return allowedVia('filesystem_policy', subject)
      return ask({ rule: 'filesystem_policy', subject, reason: `Workspace policy requires approval for ${asked.operation} access`, marks: PLAIN_MARKS, offeredScopes: ['once'] })
    },
  }
}

/**
 * The strictest rule for an operation on a path inside `path`, not covering it: `deny` before `ask`, or null for none. A
 * folder removed with everything in it takes those paths with it, one landed whole puts files on them, and one moved whole
 * takes them out from under a read rule, so their rules judge it too.
 */
function restrictionBeneath(input: { root: string; path: string; operation: 'read' | 'write'; policy: WorkspacePolicy; caseInsensitive?: boolean; platform?: NodeJS.Platform }): 'deny' | 'ask' | null {
  const platform = input.platform ?? process.platform
  const met = (input.policy.filesystem?.rules ?? []).flatMap((rule) => {
    const restriction = rule[input.operation]
    if (restriction !== 'deny' && restriction !== 'ask') return []
    const named = rulePath(input.root, rule.path, platform)
    const targets = [named, canonicalPolicyPath(named, platform)]
    return targets.some(target => isInsideComparable(input.path, target, input.caseInsensitive, platform)) ? [restriction] : []
  })
  return met.includes('deny') ? 'deny' : met.includes('ask') ? 'ask' : null
}

export async function projectFilesystemSandbox(input: { root: string; policy: WorkspacePolicy; signal?: AbortSignal; platform?: NodeJS.Platform }) {
  const platform = input.platform ?? process.platform
  const hiddenPaths = new Set<string>()
  const hiddenFiles = new Set<string>()
  const readOnlyWorkspacePaths = new Set<string>()
  const root = nativePath(await realpath(input.root))
  const rules = input.policy.filesystem?.rules ?? []
  for (const rule of rules) {
    input.signal?.throwIfAborted()
    const read = resolveFilesystemPermission({ ...input, path: rule.path, operation: 'read' })
    const write = resolveFilesystemPermission({ ...input, path: rule.path, operation: 'write' })
    if (!['ask', 'deny'].includes(read) && !['ask', 'deny'].includes(write)) continue
    // What is hidden here is handed to the sandbox as a path the kernel reads, where a backslash on Linux is part of
    // a name: such a rule is refused, never hidden at the other path pathe would read.
    if (platform !== 'win32' && rule.path.includes('\\')) throw new Error(`The filesystem rule ${rule.path} holds a backslash, which Buckle reads as a separator`)
    const named = rulePath(root, rule.path, platform)
    if (!isInside(root, named, platform)) throw new Error('Filesystem policy escaped its workspace')
    const existing = await nearestExisting(named)
    const canonical = nativePath(await realpath(existing))
    if (!isInside(root, canonical, platform)) throw new Error('Filesystem policy resolves outside its workspace')
    if (read === 'ask' || read === 'deny') {
      if ((await lstat(canonical)).isDirectory()) hiddenPaths.add(canonical)
      else hiddenFiles.add(canonical)
    } else readOnlyWorkspacePaths.add(canonical)
  }
  return { hiddenPaths: [...hiddenPaths], hiddenFiles: [...hiddenFiles], readOnlyWorkspacePaths: [...readOnlyWorkspacePaths] }
}

async function nearestExisting(path: string): Promise<string> {
  try { await lstat(path); return path }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const parent = parentDirectory(path)
    if (parent === path) throw error
    return nearestExisting(parent)
  }
}

/**
 * Where a workspace rule's path lies. Off Windows its names are appended to the root as text (childPath): pathe reads
 * `c:/secret.txt` as the drive `C:/`, whose real path does not exist there, so every file call in that workspace
 * failed; the rule covers `<ws>/c:/secret.txt`. On Windows a colon in a name is refused, and pathe's reading stands.
 */
function rulePath(root: string, path: string, platform: NodeJS.Platform): string {
  if (path === '.') return root
  return platform === 'win32' ? resolvePath(root, path) : childPath(root, path)
}

/** A rule's path as the disk names it (realpathSync.native: the case it stores), so it compares with judged effect paths. */
function canonicalPolicyPath(path: string, platform: NodeJS.Platform): string {
  let real: string
  try { real = realpathSync.native(path) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const parent = parentDirectory(path)
    if (parent === path) throw error
    return childPath(canonicalPolicyPath(parent, platform), relative(parent, path))
  }
  return nativePath(real, platform)
}
