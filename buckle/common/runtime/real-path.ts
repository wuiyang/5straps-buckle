import { realpathSync } from 'node:fs'
import { basename } from 'pathe'
import { childPath, nativePath, parentDirectory } from '../domain/paths.js'

/** The real path of a directory, or of its nearest existing ancestor with the rest appended. */
export function realPathOf(path: string, platform: NodeJS.Platform = process.platform): string {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    const parent = parentDirectory(path)
    return parent === path ? path : childPath(realPathOf(parent, platform), basename(path))
  }
  return nativePath(real, platform)
}
