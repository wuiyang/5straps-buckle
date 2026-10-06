import { opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'pathe'
import { z } from 'zod'
import { homeDirectory, isInside, isPlainName, nativePath, parentDirectory } from '../../domain/paths.js'
import { WorkspaceError } from '../workspaces/workspace-manager.js'

export const DirectoryQuerySchema = z.object({
  path: z.string().max(4096).default('~/'),
  cursor: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export interface DirectoryEntry { name: string; path: string; type: 'directory' | 'file' | 'symlink'; symlink: boolean; selectable: boolean; reason?: string }

export async function browseDirectories(input: z.infer<typeof DirectoryQuerySchema> & {
  workspaceRoot?: string
  includeFiles?: boolean
  eligibility?: (path: string) => { selectable: boolean; reason?: string }
}) {
  const named = input.workspaceRoot ? resolve(input.workspaceRoot, input.path || '.') : expandHome(input.path)
  let path: string
  try { path = await realpath(named) } catch { throw new WorkspaceError('Directory does not exist or cannot be read') }
  try { path = nativePath(path) } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : String(error)) }
  if (input.workspaceRoot && !isInside(input.workspaceRoot, path)) throw new WorkspaceError('Directory is outside the workspace')
  const display = (value: string) => input.workspaceRoot ? relative(input.workspaceRoot, value).split('\\').join('/') || '.' : value
  const entries: DirectoryEntry[] = []
  let scanned = 0
  let nextCursor: string | null = null
  try {
    for await (const item of await opendir(path)) {
      if (scanned++ < input.cursor) continue
      if (entries.length === input.limit) { nextCursor = String(scanned - 1); break }
      // pathe would read a backslash in the name as a separator and show another path: left out.
      if (!isPlainName(item.name)) continue
      const child = join(path, item.name)
      let directory = item.isDirectory()
      let canonical = child
      let reason: string | undefined
      if (item.isSymbolicLink()) {
        try { canonical = nativePath(await realpath(child)); directory = (await stat(canonical)).isDirectory() }
        catch { reason = 'Symbolic link cannot be resolved' }
      }
      if (!input.includeFiles && !directory) continue
      const outside = input.workspaceRoot && !isInside(input.workspaceRoot, canonical)
      const eligibility = reason ? { selectable: false, reason } : outside ? { selectable: false, reason: 'Symbolic link leaves this workspace' } : directory ? input.eligibility?.(canonical) ?? { selectable: true } : { selectable: false }
      entries.push({ name: item.name, path: display(child), type: item.isSymbolicLink() ? 'symlink' : directory ? 'directory' : 'file', symlink: item.isSymbolicLink(), ...eligibility })
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('Directory cannot be listed by the Buckle service account')
  }
  const parent = parentDirectory(path)
  return { path: display(path), parent: parent === path || input.workspaceRoot && !isInside(input.workspaceRoot, parent) ? null : display(parent), entries, nextCursor }
}

function expandHome(path: string): string {
  if (path === '~' || path === '~/') return homeDirectory()
  if (path.startsWith('~/')) return resolve(homeDirectory(), path.slice(2))
  if (!isAbsolute(path)) throw new WorkspaceError('Enter an absolute path or ~/ for the Buckle account home')
  return path
}
