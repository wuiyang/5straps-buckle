import { lstat, readdir, stat } from 'node:fs/promises'
import { sensitivePathReason } from '../../domain/permission/rules/sensitive-path-rule.js'
import { childPath, entryBelowRoot, isInsideAny, isPlainName } from '../../domain/paths.js'
import { ToolInputError } from '../../domain/tool.js'

export async function collectShellHiddenPaths(input: { roots: string[]; protectedPaths: string[]; signal: AbortSignal }): Promise<{ directories: string[]; files: string[] }> {
  const directories = new Set<string>()
  const files = new Set<string>()
  for (const path of input.protectedPaths) (await isFile(path) ? files : directories).add(path)
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
  return { directories: [...directories], files: [...files] }
}

// A file is masked by binding /dev/null over it, never by a folder over it, which the sandbox cannot lay there. A path
// that is not there, or cannot be read, keeps the folder mask the state directory takes.
async function isFile(path: string): Promise<boolean> {
  return stat(path).then(info => info.isFile(), () => false)
}
