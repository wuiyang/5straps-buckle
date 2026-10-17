import { createHash } from 'node:crypto'
import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, fileVersion } from '../../adapters/json-file-store.js'
import { logger } from '../../runtime/log.js'
import type { JudgeInput, JudgeProvider, JudgeVerdict } from '../../types/ports/judge.js'

/** The most verdicts a workspace keeps; past it the oldest is dropped (D91, addendum B). */
export const JUDGE_CACHE_LIMIT = 1_000

/** How long a verdict is kept (D91, addendum 2 D): an older one is a miss, and the file drops it at its next write. */
export const JUDGE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

const VerdictSchema = z.object({
  kind: z.literal('verdict'), level: z.enum(['safe', 'warning', 'danger']), confidence: z.number().min(0).max(1),
  reasoning: z.string(), model: z.string(), latencyMs: z.number().nonnegative(), promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
})
const EntrySchema = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), at: z.iso.datetime(), verdict: VerdictSchema })
const CacheFileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema).max(JUDGE_CACHE_LIMIT) })
type CacheFile = z.infer<typeof CacheFileSchema>

/** Where a workspace keeps its verdicts: owner-only, beside its other records, under its own state directory. */
export function judgeCachePath(stateDirectory: string): string {
  return join(stateDirectory, 'judge-cache.json')
}

/**
 * What a verdict is kept under (D91, addendum B): the provider and model that gave it, the policy as it stood (its
 * updatedAt and the lists the judge was shown), the command as shown, its inline code, the sha of every file it ran,
 * sorted, every package with the version installed, whether it was a standard script, and where it ran. One byte changed in any file the code reads is a new key,
 * so all of the code is rated again.
 */
export function judgeCacheKey(input: { provider: JudgeProvider; model: string; policyUpdatedAt: string | null; asked: JudgeInput }): string {
  const { asked } = input
  const shas = asked.files.map(file => file.sha256).sort()
  const packages = asked.packages.map(item => `${item.name}@${item.version ?? ''}`).sort()
  return createHash('sha256').update(JSON.stringify([input.provider, input.model, input.policyUpdatedAt, asked.policy, asked.command, asked.inline, shas, packages, asked.standardScript, asked.cwd])).digest('hex')
}

/**
 * A workspace's kept verdicts, in memory and in judge-cache.json, so a restart keeps them, each for JUDGE_CACHE_TTL_MS
 * from when it was given; the file is read again whenever another process changed it (`buckle workspace judge-cache
 * clear`). Only a verdict is kept, never an unavailable rating. A cache that cannot be read or written fails no call: the judge is asked again, and the owner's
 * log says why once.
 */
export interface JudgeCache {
  get(key: string): JudgeVerdict | undefined
  set(key: string, verdict: JudgeVerdict): Promise<void>
  /** Empties it, returning how many verdicts it held. */
  clear(): Promise<number>
}

export function openJudgeCache(input: { filePath: string; lockDeadlineMs?: number; now?: () => number }): JudgeCache {
  const now = input.now ?? Date.now
  const fresh = (at: number) => now() - at < JUDGE_CACHE_TTL_MS
  const store = createJsonFileStore<CacheFile>({ filePath: input.filePath, schema: CacheFileSchema, fallback: { version: 1, entries: [] }, ...(input.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: input.lockDeadlineMs }) })
  let loadedVersion: string | undefined
  let memory = new Map<string, { verdict: JudgeVerdict; at: number }>()
  const load = (): Map<string, { verdict: JudgeVerdict; at: number }> => {
    const version = fileVersion(input.filePath)
    if (version === loadedVersion) return memory
    try {
      memory = new Map(store.read().entries.map(entry => [entry.key, { verdict: entry.verdict, at: Date.parse(entry.at) }] as const).filter(([, kept]) => fresh(kept.at)))
    } catch {
      memory = new Map()
    }
    loadedVersion = version
    return memory
  }
  return {
    get(key) {
      const kept = load().get(key)
      return kept && fresh(kept.at) ? kept.verdict : undefined
    },
    async set(key, verdict) {
      const at = now()
      try {
        await store.update((state) => {
          state.entries = [...state.entries.filter(entry => entry.key !== key && fresh(Date.parse(entry.at))), { key, at: new Date(at).toISOString(), verdict }].slice(-JUDGE_CACHE_LIMIT)
        })
        load().set(key, { verdict, at })
      } catch (error) {
        logger.warn('The decision AI\'s verdict could not be kept; it is asked again next time', { error })
      }
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
