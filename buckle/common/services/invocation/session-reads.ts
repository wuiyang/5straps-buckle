import { comparablePath } from '../../domain/paths.js'

/** How long a read counts as the session knowing a file, for the destructive-write check (a coordinator default, reversible). */
export const READ_WINDOW_MS = 3_600_000
/** The most files one session's read set remembers, its oldest forgotten first (the fs-verbs brief). */
export const MAX_KNOWN_PATHS = 10_000
/** The most sessions the read sets are kept for, the least recently used forgotten first, as session ids are the caller's own. */
export const MAX_KNOWN_SESSIONS = 1_000

/**
 * The files each session has seen the content of, for the destructive-write check (the fs-verbs brief): read with
 * fs_read, fs_read_batch, or a match of fs_search_content, or written by the session itself, at the real path the read
 * or write reached. Kept in memory alone and bounded, so a restart forgets every set, and the first destructive write
 * after it asks: the safe side.
 */
export interface SessionReads {
  note(sessionId: string, path: string, now?: number): void
  /** Whether the session saw the file's content within READ_WINDOW_MS. */
  knows(sessionId: string, path: string, now?: number): boolean
  /**
   * The entry at `from` (a file, or a folder with the files under it) now stands at `to`, or is gone (null). Every session's
   * sightings of what stood at `to` are forgotten, and its sightings of `from` follow it: a file moved onto a path that was
   * read is not a file that was read, and a file that was read still is where it was moved to.
   */
  relocate(from: string, to: string | null): void
}

export function createSessionReads(): SessionReads {
  const sessions = new Map<string, Map<string, number>>()
  return {
    note(sessionId, path, now = Date.now()) {
      const known = sessions.get(sessionId) ?? new Map<string, number>()
      sessions.delete(sessionId)
      sessions.set(sessionId, known)
      known.delete(path)
      known.set(path, now)
      if (known.size > MAX_KNOWN_PATHS) known.delete(known.keys().next().value!)
      if (sessions.size > MAX_KNOWN_SESSIONS) sessions.delete(sessions.keys().next().value!)
    },
    knows(sessionId, path, now = Date.now()) {
      const at = sessions.get(sessionId)?.get(path)
      return at !== undefined && now - at <= READ_WINDOW_MS
    },
    relocate(from, to) {
      const under = (base: string, path: string) => { const folded = comparablePath(path); const root = comparablePath(base); return folded === root || folded.startsWith(`${root}/`) }
      for (const known of sessions.values()) {
        const carried: Array<[string, number]> = []
        for (const [path, at] of known) {
          if (to !== null && (path === from || path.startsWith(`${from}/`))) carried.push([`${to}${path.slice(from.length)}`, at])
          // A sighting of `from` that only a folded spelling reaches is forgotten, not carried: the safe side.
          if (under(from, path) || (to !== null && under(to, path))) known.delete(path)
        }
        for (const [path, at] of carried) known.set(path, at)
      }
    },
  }
}
