import { lstat, readdir } from 'node:fs/promises'
import { join } from 'pathe'
import { sensitivePathReason } from '../../domain/permission/rules/sensitive-path-rule.js'
import { isInsideAny, isPlainName } from '../../domain/paths.js'
import { ToolInputError } from '../../domain/tool.js'

export async function collectShellHiddenPaths(input: { roots: string[]; protectedPaths: string[]; signal: AbortSignal }): Promise<{ directories: string[]; files: string[] }> {
  const directories = new Set(input.protectedPaths)
  const files = new Set<string>()
  let visited = 0
  async function visit(path: string): Promise<void> {
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
      // read it as a separator and hide another path, so a workspace holding one is refused.
      if (!isPlainName(name)) throw new ToolInputError('The workspace holds a file name with a backslash, which Buckle cannot hide from shell commands', { code: 'PERMISSION_DENIED' })
      await visit(join(path, name))
    }
  }
  for (const root of new Set(input.roots)) await visit(root)
  return { directories: [...directories], files: [...files] }
}
