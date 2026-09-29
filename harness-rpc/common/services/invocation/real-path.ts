import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ToolInputError } from '../../domain/tool.js'

/** How many links one path may pass through, as Linux allows (SYMLOOP_MAX). */
const MAX_LINKS = 40

/**
 * Where a path really lands: the real path of an existing target, or, for one that does not exist
 * yet, where a write would create it. Each missing component is lstat'ed, so a dangling link is
 * followed to its target, recursively, instead of being judged by its own path while a write follows
 * it (review H1 and H2 of B23-B25). Link targets are resolved component by component, so a `..`
 * after a link climbs from where the link really points, as the kernel does. A path that passes
 * through more than MAX_LINKS links is refused.
 */
export function resolveTarget(absolutePath: string): string {
  try {
    return realpathSync(absolutePath)
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
    let isLink: boolean
    try {
      isLink = lstatSync(next).isSymbolicLink()
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      // Nothing exists from here on: the rest names where a write would create it.
      return resolve(next, ...parts.slice(index + 1))
    }
    if (!isLink) { current = next; continue }
    if (++budget.links > MAX_LINKS) throw tooManyLinks(next)
    const target = readlinkSync(next)
    current = walk(isAbsolute(target) ? '/' : current, target.split('/'), budget)
  }
  return current
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
