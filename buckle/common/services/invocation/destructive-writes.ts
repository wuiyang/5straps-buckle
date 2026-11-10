import { constants, fstatSync, readFileSync, statSync } from 'node:fs'
import { withFileBeneath } from '../../adapters/beneath.js'
import type { DestructiveWriteEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import type { PreparedCall } from '../../domain/tool.js'
import { resolveTarget } from './real-path.js'
import type { SessionReads } from './session-reads.js'

/** A write that leaves a file fewer than this share of its bytes shrinks it (a coordinator default, reversible). */
export const SHRINK_RATIO = 0.5
/** One call that rewrites more existing files than this asks a person, whatever it writes (a coordinator default, reversible). */
export const BATCH_REWRITE_LIMIT = 10
/** The largest file the check reads to work out what a patch leaves of it, as fs_read reads one. */
const MAX_READ_BYTES = 10 * 1_048_576

/**
 * The destructive-write check (the fs-verbs brief): run before any rule judges a call whose tool says what each file it
 * writes holds afterwards (ToolDefinition.written). A write that empties an existing file, or leaves it under
 * SHRINK_RATIO of its size, where the session has not seen that file's content lately (SessionReads), and one call that
 * rewrites more than BATCH_REWRITE_LIMIT existing files, each become an effect the destructive floor asks about, whatever
 * the folder's write grant says. A tool works out a patch's result from the file as it stands, which is read here only
 * where the session may read it without asking a person (`readable`); elsewhere the call's own read asks one anyway.
 * Without a read set (a runtime that keeps none) no file counts as read: the safe side.
 */
export function destructiveWrites(input: {
  written: PreparedCall['written']
  sessionId: string
  reads: SessionReads | undefined
  paths: PathView
  /** Whether the session may read a real path without asking a person, by the rules and the grants it holds. */
  readable: (target: string) => boolean
  protectedRoots: readonly string[]
}): DestructiveWriteEffect[] {
  if (!input.written) return []
  const landing = (named: string): string | null => {
    try { return resolveTarget(input.paths.resolve(named), { shares: input.paths.shares }) } catch { return null }
  }
  const current = (named: string): Buffer | null => {
    const target = landing(named)
    if (target === null || !input.readable(target)) return null
    try {
      return withFileBeneath(target, { flags: constants.O_RDONLY, protectedRoots: input.protectedRoots, roots: input.paths.reachableRoots }, descriptor => (fstatSync(descriptor).size > MAX_READ_BYTES ? null : readFileSync(descriptor)))
    } catch {
      return null
    }
  }
  const effects: DestructiveWriteEffect[] = []
  const existing = new Set<string>()
  for (const file of input.written(current)) {
    const target = landing(file.path)
    const before = target === null ? undefined : sizeOf(target)
    if (target === null || before === undefined) continue
    existing.add(target)
    const shrinks = before > 0 && (file.size === 0 || file.size < before * SHRINK_RATIO)
    if (shrinks && !input.reads?.knows(input.sessionId, target)) effects.push({ kind: 'unread_shrink', path: target, empties: file.size === 0 })
  }
  if (existing.size > BATCH_REWRITE_LIMIT) effects.push({ kind: 'many_rewrites', files: existing.size })
  return effects
}

function sizeOf(target: string): number | undefined {
  try {
    const info = statSync(target, { throwIfNoEntry: false })
    return info?.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}
