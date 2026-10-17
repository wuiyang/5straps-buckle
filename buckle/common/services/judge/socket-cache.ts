import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, fileVersion } from '../../adapters/json-file-store.js'
import { logger } from '../../runtime/log.js'
import type { PackageScanner, SocketSummary } from '../../types/ports/package-scan.js'

/** The most Socket summaries a workspace keeps; past it the oldest is dropped (D91, addendum 2 C). */
export const SOCKET_CACHE_LIMIT = 2_000

/** How long a summary is kept: an older one is asked of Socket again (D91, addendum 2 C). */
export const SOCKET_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

const Score = z.number().min(0).max(1).nullable()
const SummarySchema = z.object({
  score: z.object({ overall: Score, supplyChain: Score, quality: Score, maintenance: Score, vulnerability: Score, license: Score }),
  alerts: z.array(z.object({ type: z.string(), severity: z.string() })),
})
const EntrySchema = z.object({ purl: z.string().min(1).max(1_024), at: z.iso.datetime(), summary: SummarySchema })
const CacheFileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema).max(SOCKET_CACHE_LIMIT) })
type CacheFile = z.infer<typeof CacheFileSchema>

/** Where a workspace keeps Socket's summaries: owner-only, beside judge-cache.json. */
export function socketCachePath(stateDirectory: string): string {
  return join(stateDirectory, 'socket-cache.json')
}

/** A scanner that answers from the summaries kept in the last SOCKET_CACHE_TTL_MS and asks for the rest; `clear` empties it. */
export interface CachedScanner extends PackageScanner {
  clear(): Promise<number>
}

/**
 * Socket's summaries by package URL, in memory and in socket-cache.json, so a restart keeps them for a day; the file is
 * read again whenever another process changed it. Only a summary Socket gave is kept, never a package it answered
 * nothing for. A cache that cannot be read or written fails no rating: Socket is asked again.
 */
export function openSocketCache(input: { scanner: PackageScanner; filePath: string; lockDeadlineMs?: number; now?: () => number }): CachedScanner {
  const now = input.now ?? Date.now
  const fresh = (at: number) => now() - at < SOCKET_CACHE_TTL_MS
  const store = createJsonFileStore<CacheFile>({ filePath: input.filePath, schema: CacheFileSchema, fallback: { version: 1, entries: [] }, ...(input.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: input.lockDeadlineMs }) })
  let loadedVersion: string | undefined
  let memory = new Map<string, { summary: SocketSummary; at: number }>()
  const load = () => {
    const version = fileVersion(input.filePath)
    if (version === loadedVersion) return memory
    try {
      memory = new Map(store.read().entries.map(entry => [entry.purl, { summary: entry.summary, at: Date.parse(entry.at) }] as const).filter(([, kept]) => fresh(kept.at)))
    } catch {
      memory = new Map()
    }
    loadedVersion = version
    return memory
  }
  return {
    async scan(purls, signal) {
      const kept = load()
      const answers = new Map<string, SocketSummary | null>()
      const asked: string[] = []
      for (const purl of purls) {
        const hit = kept.get(purl)
        if (hit && fresh(hit.at)) answers.set(purl, hit.summary)
        else asked.push(purl)
      }
      if (asked.length === 0) return answers
      const scanned = await input.scanner.scan(asked, signal)
      const given = asked.flatMap(purl => { const summary = scanned.get(purl) ?? null; answers.set(purl, summary); return summary === null ? [] : [{ purl, summary }] })
      if (given.length === 0) return answers
      const at = now()
      try {
        await store.update((state) => {
          const replaced = new Set(given.map(item => item.purl))
          state.entries = [...state.entries.filter(entry => !replaced.has(entry.purl) && fresh(Date.parse(entry.at))), ...given.map(item => ({ purl: item.purl, at: new Date(at).toISOString(), summary: item.summary }))].slice(-SOCKET_CACHE_LIMIT)
        })
        for (const item of given) load().set(item.purl, { summary: item.summary, at })
      } catch (error) {
        logger.warn('Socket\'s package summaries could not be kept; they are asked for again next time', { error })
      }
      return answers
    },
    async clear() {
      const held = (() => { try { return store.read().entries.length } catch { return 0 } })()
      await store.write({ version: 1, entries: [] })
      memory = new Map()
      loadedVersion = undefined
      return held
    },
  }
}
