import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ToolInputError } from '../../domain/tool.js'

/** How many links one path may pass through, as Linux allows (SYMLOOP_MAX). */
const MAX_LINKS = 40

/**
 * Where a path really lands: the real path of an existing target, or, for one that does not exist
 * yet, where a write would create it. Each missing component is lstat'ed, so a dangling link is
 * followed to its target, recursively, instead of being judged by its own path while a write follows
 * it (review H1 and H2 of B23-B25). Link targets are resolved component by component, so a `..`
 * after a link climbs from where the link really points, as the kernel does. A path that passes
 * through more than MAX_LINKS links, or climbs back out of a directory that does not exist, is refused.
 */
export function resolveTarget(absolutePath: string): string {
  try {
    // The C library's realpath, as the kernel resolves: Node's own folds a link target's `..` as text.
    return realpathSync.native(absolutePath)
  } catch (error) {
    if (isLinkLoop(error)) throw tooManyLinks(absolutePath)
    if (!isMissingPathError(error)) throw error
  }
  return walk('/', absolutePath.split('/'), { links: 0 })
}

/** The same resolution for callers that await; kept async so a later non-blocking lookup changes no caller. */
export async function realPathOrPlanned(absolutePath: string): Promise<string> {
  return resolveTarget(absolutePath)
}

function walk(start: string, parts: string[], budget: { links: number }): string {
  let current = start
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue
    if (part === '..') { current = dirname(current); continue }
    const next = join(current, part)
    let info: Stats
    try {
      info = lstatSync(next)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      return planned(next, parts.slice(index + 1))
    }
    // A file with more components after it is where the kernel answers ENOTDIR: nothing beneath it exists.
    if (!info.isSymbolicLink() && !info.isDirectory()) return planned(next, parts.slice(index + 1))
    if (!info.isSymbolicLink()) { current = next; continue }
    if (++budget.links > MAX_LINKS) throw tooManyLinks(next)
    const target = readlinkSync(next)
    current = walk(isAbsolute(target) ? '/' : current, target.split('/'), budget)
  }
  return current
}

/**
 * Nothing exists beneath `missing`: the rest names where a write would create it. A `..` there climbs
 * out of a directory that does not exist, which the kernel answers ENOENT or ENOTDIR; read as text it would name
 * a path through links nobody followed (`a -> nope/../L/x`), so it is refused (review item 0 of the
 * proof-of-possession fixes). Only a link target can bring one here: PathView already folded the agent's own.
 */
function planned(missing: string, rest: string[]): string {
  if (rest.includes('..')) throw new ToolInputError('A symbolic link in this path climbs back out of a directory that does not exist, so where it lands cannot be checked', { code: 'PERMISSION_DENIED' })
  return join(missing, ...rest)
}

function tooManyLinks(path: string): ToolInputError {
  return new ToolInputError(`${path} passes through more than ${MAX_LINKS} symbolic links, so where it lands cannot be checked`, { code: 'PERMISSION_DENIED' })
}

function isLinkLoop(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOOP'
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
