import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, posix } from 'pathe'
import { z } from 'zod'
import { homeDirectory, isInside, nativePath } from './paths.js'

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

/** Explicit mounts expose credentials, but cannot alias workspace restrictions or private node state. */
export function validateSandboxMounts(mounts: SandboxMount[], input: { protectedRoots: string[]; workspaceRoots: string[]; workspaceTarget: string }): SandboxMount[] {
  const reserved = ['/', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/sys', input.workspaceTarget, ...input.protectedRoots, ...input.workspaceRoots]
  const canonical = (path: string) => {
    try { return nativePath(realpathSync(path)) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path
      throw error
    }
  }
  const forbiddenSources = [...input.protectedRoots, ...input.workspaceRoots].map(canonical)
  const result: SandboxMount[] = []
  for (const mount of mounts) {
    const source = nativePath(realpathSync(mount.source))
    const info = statSync(source)
    if (!info.isFile() && !info.isDirectory()) throw new Error('Explicit mounts support regular files and directories only')
    if (forbiddenSources.some(path => overlaps(source, path))) throw new Error('Mount source overlaps a workspace or protected Buckle state')
    if (mount.target === '/' || reserved.slice(1).some(path => overlaps(mount.target, path)) || mount.target === '/tmp' || mount.target === SANDBOX_HOME) throw new Error('Mount target overlaps a reserved sandbox path')
    if (result.some(entry => overlaps(entry.target, mount.target))) throw new Error('Mount targets must not overlap')
    result.push({ ...mount, source })
  }
  return result
}

function overlaps(a: string, b: string): boolean { return isInside(a, b) || isInside(b, a) }
