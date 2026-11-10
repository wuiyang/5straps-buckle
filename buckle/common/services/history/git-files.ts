import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'pathe'

/** Git reads every file as raw bytes: no line ending, filter, ident, or encoding change, so a blob id is the file's own. */
export const RAW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n**/* -text -filter -ident -working-tree-encoding\n'

export function escapeIgnore(path: string): string { return path.replace(/[\\*?\[\] !#]/g, '\\$&') }
/** The git folder of the repository `workTree` lies in, its common one for a linked worktree; undefined outside one. */
export function ownerGitDirectory(workTree: string): string | undefined {
  let root = workTree
  while (true) {
    const marker = join(root, '.git'); const stat = lstatSync(marker, { throwIfNoEntry: false })
    if (stat) {
      let directory: string
      if (stat.isDirectory() || stat.isSymbolicLink()) { try { directory = realpathSync(marker) } catch { return undefined } }
      else {
        const pointer = readGitMetadata(marker)
        if (!pointer || !/^gitdir: [^\0\r\n]+\n?$/.test(pointer)) return undefined
        directory = resolve(root, pointer.slice(8).trim())
      }
      const common = join(directory, 'commondir')
      if (existsSync(common)) { const pointer = readGitMetadata(common); if (!pointer || /[\0\r\n]./.test(pointer.trim())) return undefined; directory = resolve(directory, pointer.trim()) }
      return directory
    }
    if (dirname(root) === root) return undefined
    root = dirname(root)
  }
}
export function readGitMetadata(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size > 8192) return undefined
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size > 8192 || opened.ino !== stat.ino || opened.dev !== stat.dev) return undefined
    const content = Buffer.alloc(8193)
    let bytes = 0
    while (bytes < content.length) {
      const read = readSync(descriptor, content, bytes, content.length - bytes, null)
      if (!read) break
      bytes += read
    }
    const final = fstatSync(descriptor)
    if (bytes > 8192 || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) return undefined
    return content.toString('utf8', 0, bytes)
  } catch { return undefined }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
export function regularFile(path: string, size?: number): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat?.isFile() === true && stat.nlink === 1 && (size === undefined || stat.size === size)
}
