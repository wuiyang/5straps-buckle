import { lstat, readdir, stat } from 'node:fs/promises'
import { sensitivePathReason } from '../../domain/permission/rules/sensitive-path-rule.js'
import { childPath, entryBelowRoot, isInsideAny, isPlainName } from '../../domain/paths.js'
import { ToolInputError } from '../../domain/tool.js'

/** What a shell command must not see: folders and files to mask, and the node's settings files not made yet. */
export interface ShellHiddenPaths { directories: string[]; files: string[]; missingFiles: string[] }

/** `settingsFiles`: the protected paths known to be files (protectedSettingsFiles), whether or not they are there. */
export async function collectShellHiddenPaths(input: { roots: string[]; protectedPaths: string[]; settingsFiles?: readonly string[]; signal: AbortSignal }): Promise<ShellHiddenPaths> {
  const directories = new Set<string>()
  const files = new Set<string>()
  const missingFiles = new Set<string>()
  for (const path of input.protectedPaths) {
    const kind = await kindOf(path)
    if (kind === 'file') files.add(path)
    else if (kind === 'missing' && input.settingsFiles?.includes(path)) missingFiles.add(path)
    else directories.add(path)
  }
  let visited = 0
  async function visit(path: string, root: string): Promise<void> {
    input.signal.throwIfAborted()
    if (++visited > 100_000) throw new ToolInputError('Workspace is too large to scan safely for shell credential protection', { code: 'PERMISSION_DENIED' })
    const info = await lstat(path)
    if (isInsideAny(input.protectedPaths, path) || sensitivePathReason(path)) {
      if (info.isDirectory()) directories.add(path)
      else files.add(path)
      return
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return
    for (const name of await readdir(path)) {
      // The hidden paths go to the sandbox as the kernel reads them, where a backslash is part of a name; pathe would
      // read it as a separator and hide another path, so a workspace holding one is refused, naming it as listed.
      if (!isPlainName(name)) throw new ToolInputError(`The workspace holds ${entryBelowRoot(root, path, name)}, a name with a backslash, which Buckle cannot hide from shell commands`, { code: 'PERMISSION_DENIED' })
      await visit(childPath(path, name), root)
    }
  }
  for (const root of new Set(input.roots)) await visit(root, root)
  return { directories: [...directories], files: [...files], missingFiles: [...missingFiles] }
}

/**
 * Bubblewrap makes a mask's mount point where nothing is, so a settings file not made yet, where a command writes on the
 * host, cannot be masked without leaving something there for the node to read as its settings: the call is refused,
 * naming no path.
 */
export function refuseUnmadeSettingsFiles(input: { missingFiles: readonly string[]; hostWritable: readonly string[] }): void {
  if (!input.missingFiles.some(path => isInsideAny([...input.hostWritable], path))) return
  throw new ToolInputError('The node\'s settings file is not made yet inside a folder this command writes, so the sandbox cannot hide it there: the owner makes it first, with buckle init --out <file>', { code: 'PERMISSION_DENIED' })
}

// A file is masked by binding /dev/null over it, never by a folder over it, which the sandbox cannot lay there. Any
// other path not there, or one that cannot be read, keeps the folder mask the state directory takes.
async function kindOf(path: string): Promise<'file' | 'folder' | 'missing'> {
  return stat(path).then(info => (info.isFile() ? 'file' : 'folder'), (error: unknown) => (isMissing(error) ? 'missing' : 'folder'))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
