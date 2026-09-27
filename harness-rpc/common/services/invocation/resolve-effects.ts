import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ResolvedEffect, ToolEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
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
  if (effect.kind === 'read_path' || effect.kind === 'write_path') {
    const path = await realPathOrPlanned(paths.resolve(effect.path))
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

async function containingDirectory(path: string): Promise<string> {
  try {
    if ((await stat(path)).isDirectory()) return path
  } catch {
    // A path that does not exist yet is judged by the directory it would be created in.
  }
  return dirname(path)
}
