import { lstatSync } from 'node:fs'
import { dirname } from 'pathe'
import { ToolInputError } from '../../../domain/tool.js'
import { FILE_NOT_FOUND, PARENT_MISSING, SEARCH_ROOT_UNREADABLE } from './transfer.js'

/**
 * What an open that ran into a path of nothing says to the agent that sent the path. The system's own words name the
 * descriptor path a pinned open went through, so an agent reads these instead: the path as it sent it, never the host's.
 * A path that goes through a file (ENOTDIR) is a path of nothing too. Any other error is returned as it is.
 */
export function missingRefusal(error: unknown, input: { named: string; wanted: 'file' | 'folder'; outcome: string }): unknown {
  const code = errnoOf(error)
  if (code === 'ENOENT') return new ToolInputError(`There is no ${input.wanted} at ${input.named}, so ${input.outcome}`, { code: FILE_NOT_FOUND })
  if (code === 'ENOTDIR') return new ToolInputError(`A part of the path ${input.named} is a file, not a folder, so ${input.outcome}`, { code: FILE_NOT_FOUND })
  return error
}

/**
 * As missingRefusal for a path that must be a folder. Where the path itself is a file (`target`, its real path, stands
 * as one), the file exists, so the refusal says so in the code a search gives for it; a file higher in the path is still
 * a path of nothing.
 */
export function folderRefusal(error: unknown, input: { named: string; outcome: string; target: string }): unknown {
  if (errnoOf(error) === 'ENOTDIR' && isFile(input.target)) return new ToolInputError(`${input.named} is a file, not a folder, so ${input.outcome}`, { code: SEARCH_ROOT_UNREADABLE })
  return missingRefusal(error, { named: input.named, wanted: 'folder', outcome: input.outcome })
}

/** As missingRefusal for a write that makes no folder: the open of a file it may create fails for its folder alone. */
export function parentRefusal(error: unknown, named: string): unknown {
  const code = errnoOf(error)
  if (code === 'ENOENT') return new ToolInputError(`The folder ${folderOf(named)} does not exist, and a write makes no folder unless createParents is true: create it first, or send createParents: true`, { code: PARENT_MISSING })
  if (code === 'ENOTDIR') return new ToolInputError(`A part of the path ${named} is a file, not a folder, so nothing was written`, { code: PARENT_MISSING })
  return error
}

/** Runs an open, and throws what `refuse` makes of its error. */
export function refusing<T>(operation: () => T, refuse: (error: unknown) => unknown): T {
  try { return operation() } catch (error) { throw refuse(error) }
}

function isFile(path: string): boolean {
  try { return lstatSync(path).isFile() } catch { return false }
}

function folderOf(named: string): string {
  const folder = dirname(named)
  return folder === '.' || folder === '' ? named : folder
}

function errnoOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
