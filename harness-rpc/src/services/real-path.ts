import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Real path of an existing target. For a path that does not exist yet, the real path of
 * its nearest existing ancestor with the remaining segments appended. This keeps a symlinked
 * parent directory from hiding where a new file would actually land.
 */
export async function realPathOrPlanned(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    const parent = dirname(absolutePath)
    if (parent === absolutePath) return absolutePath
    const realParent = await realPathOrPlanned(parent)
    return `${realParent}/${absolutePath.slice(parent.length + 1)}`
  }
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
