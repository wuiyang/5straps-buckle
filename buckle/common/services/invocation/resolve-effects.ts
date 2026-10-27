import { stat } from 'node:fs/promises'
import { basename, dirname } from 'pathe'
import type { ResolvedEffect, ToolEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import { childPath, isPlainName, parentDirectory } from '../../domain/paths.js'
import { missingMountReason, mountSourceState } from '../../domain/sandbox-mounts.js'
import { ToolInputError } from '../../domain/tool.js'
import { realPathOrPlanned } from './real-path.js'

/**
 * Turns declared effects into the absolute, symlink-resolved form rules judge. Resolution
 * happens before any permission check so a symlink cannot smuggle a path past the scope rules,
 * and a path the agent named under the mount is judged where it really is.
 */
export async function resolveEffects(input: { effects: ToolEffect[]; paths: PathView }): Promise<ResolvedEffect[]> {
  const resolved: ResolvedEffect[] = []
  for (const effect of input.effects) resolved.push(await resolveOne(effect, input.paths))
  return resolved
}

async function resolveOne(effect: ToolEffect, paths: PathView): Promise<ResolvedEffect> {
  if (effect.kind === 'delete_path') {
    const entry = await resolveEntry(effect.path, paths)
    return { kind: 'delete_path', ...entry, floor: effect.floor, ...(effect.tree ? { tree: effect.tree } : {}) }
  }
  if (effect.kind === 'write_path' && effect.entry) return { kind: 'write_path', ...await resolveEntry(effect.path, paths), entry: true }
  if (effect.kind === 'read_path' || effect.kind === 'write_path') {
    // A host path the tool settled is judged as resolveHostRead judges one, never through the agent's view.
    const named = effect.kind === 'write_path' && effect.host ? effect.path : paths.resolve(effect.path)
    const path = await realPathOrPlanned(named, { shares: paths.shares })
    if (effect.kind === 'write_path') refuseMissingMount(path, paths)
    return { kind: effect.kind, path, directory: await containingDirectory(path) }
  }
  if (effect.kind === 'network') {
    try {
      return { kind: 'network', url: new URL(effect.url) }
    } catch {
      throw new ToolInputError(`Not a valid URL: ${effect.url}`)
    }
  }
  return effect
}

/**
 * Where an entry the agent named really is, the entry itself and never what a link there points to: its folder resolved
 * as any path is (realPathOrPlanned), and its own name kept as written. A delete unlinks a link, and a move moves or
 * replaces it, so the rules judge the link's own place. A root (the drive, `/`) names no entry in a folder and is refused.
 */
export async function resolveEntry(named: string, paths: PathView): Promise<{ path: string; directory: string }> {
  const absolute = paths.resolve(named)
  const parent = parentDirectory(absolute)
  const name = basename(absolute)
  if (parent === absolute || !isPlainName(name)) throw new ToolInputError(`${named} names no entry in a folder, so it is not removed or moved`)
  const directory = await realPathOrPlanned(parent, { shares: paths.shares })
  const path = childPath(directory, name)
  refuseMissingMount(path, paths)
  return { path, directory }
}

/**
 * A write into one of the owner's mounts whose source is gone is refused before any rule judges it, naming the mount
 * by its target: it would make a folder where the owner's was (a renamed ~/data), and history has nothing there to
 * checkpoint. A scratch root not made yet is still written, as its first write may make it.
 */
function refuseMissingMount(path: string, paths: PathView): void {
  const holder = paths.mountOf(path)
  if (holder && !holder.scratch && mountSourceState(holder.source) === 'missing') throw new ToolInputError(missingMountReason(holder.target, holder.node === true), { code: 'PERMISSION_DENIED' })
}

/**
 * A read of a host path a tool reached mid-call (a listed child beneath its judged directory, a searched
 * file, a shell's credential file), judged where it lands now. Never read through the agent's view:
 * the path is already the host's, and a mount would take it for one of its own names.
 */
export async function resolveHostRead(path: string, shares: readonly string[] = []): Promise<ResolvedEffect> {
  const target = await realPathOrPlanned(path, { shares })
  return { kind: 'read_path', path: target, directory: await containingDirectory(target) }
}

async function containingDirectory(path: string): Promise<string> {
  try {
    if ((await stat(path)).isDirectory()) return path
  } catch {
    // A path that does not exist yet is judged by the directory it would be created in.
  }
  return dirname(path)
}
