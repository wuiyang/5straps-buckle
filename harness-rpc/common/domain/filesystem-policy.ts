import { realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { FilesystemPermission, WorkspacePolicy } from '@5straps/protocol'
import { isInside } from './paths.js'
import type { PermissionRule } from './permission/decision.js'
import { allowedVia, ask, deny } from './permission/decision.js'

export interface FilesystemPolicyInput {
  path: string
  operation: 'read' | 'write'
  policy: WorkspacePolicy
  ceiling?: WorkspacePolicy | null
}
export type FilesystemDecision = FilesystemPermission | 'inherit'

export function resolveFilesystemPermission(input: FilesystemPolicyInput): FilesystemDecision {
  const own = matchRules(input.policy, input.path, input.operation)
  const ceiling = input.ceiling ? matchRules(input.ceiling, input.path, input.operation) : 'inherit'
  if (own === 'deny' || ceiling === 'deny') return 'deny'
  if (ceiling === 'ask') return 'ask'
  return own === 'inherit' ? ceiling : own
}

export function resolveFilesystemAccess(input: Omit<FilesystemPolicyInput, 'operation'>) {
  const read = resolveFilesystemPermission({ ...input, operation: 'read' })
  const write = resolveFilesystemPermission({ ...input, operation: 'write' })
  return { read: read === 'inherit' ? 'allow' as const : read, write: write === 'inherit' ? 'ask' as const : write }
}

function matchRules(policy: WorkspacePolicy, path: string, operation: 'read' | 'write'): FilesystemDecision {
  const matching = (policy.filesystem?.rules ?? []).filter(rule => rule.path === '.' || path === rule.path || path.startsWith(`${rule.path}/`))
  if (matching.some(rule => rule[operation] === 'deny')) return 'deny'
  return matching.filter(rule => rule[operation] !== undefined).sort((a, b) => b.path.length - a.path.length)[0]?.[operation] ?? 'inherit'
}

export function filesystemPathDecision(input: Omit<FilesystemPolicyInput, 'path'> & { root: string; path: string }): FilesystemDecision {
  if (!isInside(input.root, input.path)) return 'inherit'
  const canonical = (policy: WorkspacePolicy): WorkspacePolicy => ({ ...policy, filesystem: { rules: (policy.filesystem?.rules ?? []).flatMap(rule => {
    const target = canonicalPolicyPath(resolve(input.root, rule.path))
    if (!isInside(input.root, target)) return [rule]
    return [rule, { ...rule, path: relative(input.root, target).split('\\').join('/') || '.' }]
  }) } })
  return resolveFilesystemPermission({ ...input, policy: canonical(input.policy), ceiling: input.ceiling ? canonical(input.ceiling) : null, path: relative(input.root, input.path).split('\\').join('/') || '.' })
}

export function createFilesystemPolicyRule(input: { root: string; policy: WorkspacePolicy; ceiling?: WorkspacePolicy | null }): PermissionRule {
  return {
    id: 'filesystem_policy',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path' && effect.kind !== 'write_path') return null
      const operation = effect.kind === 'read_path' ? 'read' : 'write'
      const decision = filesystemPathDecision({ ...input, path: effect.path, operation })
      const subject = `${operation}:${effect.path}`
      if (decision === 'deny') return deny('filesystem_policy', subject, `Workspace policy denies ${operation} access`)
      if (decision !== 'ask') return null
      if (grants.subjectsFor('filesystem_policy').includes(subject)) return allowedVia('filesystem_policy', subject)
      return ask('filesystem_policy', subject, `Workspace policy requires approval for ${operation} access`, ['once'])
    },
  }
}

export async function projectFilesystemSandbox(input: { root: string; policy: WorkspacePolicy; ceiling?: WorkspacePolicy | null; signal?: AbortSignal }) {
  const hiddenPaths = new Set<string>()
  const hiddenFiles = new Set<string>()
  const readOnlyWorkspacePaths = new Set<string>()
  const root = await realpath(input.root)
  const rules = [...input.policy.filesystem?.rules ?? [], ...input.ceiling?.filesystem?.rules ?? []]
  for (const rule of rules) {
    input.signal?.throwIfAborted()
    const read = resolveFilesystemPermission({ ...input, path: rule.path, operation: 'read' })
    const write = resolveFilesystemPermission({ ...input, path: rule.path, operation: 'write' })
    if (!['ask', 'deny'].includes(read) && !['ask', 'deny'].includes(write)) continue
    const named = resolve(root, rule.path)
    if (!isInside(root, named)) throw new Error('Filesystem policy escaped its workspace')
    const existing = await nearestExisting(named)
    const canonical = await realpath(existing)
    if (!isInside(root, canonical)) throw new Error('Filesystem policy resolves outside its workspace')
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
    const parent = dirname(path)
    if (parent === path) throw error
    return nearestExisting(parent)
  }
}

function canonicalPolicyPath(path: string): string {
  try { return realpathSync(path) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(canonicalPolicyPath(parent), relative(parent, path))
  }
}
