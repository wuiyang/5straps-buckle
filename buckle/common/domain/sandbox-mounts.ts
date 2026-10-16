import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, posix } from 'pathe'
import { z } from 'zod'
import { comparablePath, homeDirectory, isInside, nativePath } from './paths.js'
import { ToolInputError } from './tool.js'

export const SANDBOX_HOME = '/tmp/home'

const mountSchema = z.array(z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  readOnly: z.literal(true).default(true),
}).strict()).max(32)
export type SandboxMount = z.infer<typeof mountSchema>[number]

export function parseSandboxMounts(value: string | undefined): SandboxMount[] {
  if (!value?.trim()) return []
  try {
    return mountSchema.parse(JSON.parse(value)).map(mount => {
      const source = mount.source.startsWith('~/') ? join(homeDirectory(), mount.source.slice(2)) : mount.source
      const target = mount.target.startsWith('~/') ? `${SANDBOX_HOME}/${mount.target.slice(2)}` : mount.target
      if (!isAbsolute(source) || !target.startsWith('/') || /[\0\r\n]/.test(source + target)) throw new Error('Invalid mount path')
      if (posix.normalize(target) !== target) throw new Error('Mount targets must be normalized absolute paths')
      return { ...mount, source, target }
    })
  } catch {
    throw new Error('BUCKLE_MOUNTS must be a JSON array of {source, target, readOnly: true}; use absolute paths or ~/ (host home for sources, sandbox home for targets)')
  }
}

/**
 * Where a mount's stored source is now: `present` where it still lands on itself, `missing` where nothing is there, and
 * `moved` where it, or a folder above it, was swapped for a link since the owner added it (the source is stored as the
 * disk names it, links followed). Compared as the disk compares names.
 */
export function mountSourceState(source: string): 'present' | 'missing' | 'moved' {
  let real: string
  try { real = nativePath(realpathSync.native(source)) } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 'missing'
    throw error
  }
  return comparablePath(real) === comparablePath(nativePath(source)) ? 'present' : 'moved'
}

/** Why a mount whose source moved is refused: named by its target alone, never by the source the owner chose. */
export function movedMountReason(target: string): string {
  return `The mount at ${target} changed on disk since the owner added it, so Buckle uses nothing there; the owner re-adds it`
}

/** Why a mount whose source is gone is refused, by its target alone. */
export function missingMountReason(target: string): string {
  return `The mount at ${target} has no source on disk; the owner re-adds it, or removes it with buckle workspace mount remove ${target}`
}

/**
 * Mounts expose what they hold, credentials included, but cannot alias workspace restrictions or private node state:
 * each source is checked where it really lands at every use, and one that lands anywhere but where it was stored (a
 * folder swapped for a link since it was added) or is gone is refused, naming the target alone. Only the stored source
 * is ever bound.
 */
export function validateSandboxMounts<T extends { source: string; target: string }>(mounts: readonly T[], input: { protectedRoots: string[]; workspaceRoots: string[]; workspaceTarget: string }): T[] {
  const reserved = ['/', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/sys', input.workspaceTarget, ...input.protectedRoots, ...input.workspaceRoots]
  const canonical = (path: string) => {
    try { return nativePath(realpathSync(path)) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path
      throw error
    }
  }
  const forbiddenSources = [...input.protectedRoots, ...input.workspaceRoots].map(canonical)
  const result: T[] = []
  for (const mount of mounts) {
    const state = mountSourceState(mount.source)
    if (state === 'missing') throw new ToolInputError(missingMountReason(mount.target), { code: 'PERMISSION_DENIED' })
    if (state === 'moved') throw new ToolInputError(movedMountReason(mount.target), { code: 'PERMISSION_DENIED' })
    const source = nativePath(mount.source)
    const info = statSync(source)
    if (!info.isFile() && !info.isDirectory()) throw new Error('Explicit mounts support regular files and directories only')
    if (forbiddenSources.some(path => overlaps(source, path))) throw new ToolInputError(`The mount at ${mount.target} overlaps the workspace's folder or Buckle's protected state, so Buckle binds nothing there; the owner narrows it`, { code: 'PERMISSION_DENIED' })
    if (mount.target === '/' || reserved.slice(1).some(path => overlaps(mount.target, path)) || mount.target === '/tmp' || mount.target === SANDBOX_HOME) throw new Error('Mount target overlaps a reserved sandbox path')
    if (result.some(entry => overlaps(entry.target, mount.target))) throw new Error('Mount targets must not overlap')
    result.push({ ...mount, source })
  }
  return result
}

function overlaps(a: string, b: string): boolean { return isInside(a, b) || isInside(b, a) }
