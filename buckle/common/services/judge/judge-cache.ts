import { createHash } from 'node:crypto'
import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, fileVersion } from '../../adapters/json-file-store.js'
import { logger } from '../../runtime/log.js'
import type { JudgeInput, JudgeProvider, JudgeVerdict } from '../../types/ports/judge.js'

/** The most verdicts a workspace keeps; past it the oldest is dropped (D91, addendum B). */
export const JUDGE_CACHE_LIMIT = 1_000

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
 * sorted, whether it was a standard script, and where it ran. One byte changed in any file the code reads is a new key,
 * so all of the code is rated again.
 */
export function judgeCacheKey(input: { provider: JudgeProvider; model: string; policyUpdatedAt: string | null; asked: JudgeInput }): string {
  const { asked } = input
  const shas = asked.files.map(file => file.sha256).sort()
  return createHash('sha256').update(JSON.stringify([input.provider, input.model, input.policyUpdatedAt, asked.policy, asked.command, asked.inline, shas, asked.standardScript, asked.cwd])).digest('hex')
}

/**
 * A workspace's kept verdicts, in memory and in judge-cache.json, so a restart keeps them; the file is read again
 * whenever another process changed it (`buckle workspace judge-cache clear`). Only a verdict is kept, never an
 * unavailable rating. A cache that cannot be read or written fails no call: the judge is asked again, and the owner's
 * log says why once.
 */
export interface JudgeCache {
  get(key: string): JudgeVerdict | undefined
  set(key: string, verdict: JudgeVerdict): Promise<void>
  /** Empties it, returning how many verdicts it held. */
  clear(): Promise<number>
}

export function openJudgeCache(input: { filePath: string; lockDeadlineMs?: number }): JudgeCache {
  const store = createJsonFileStore<CacheFile>({ filePath: input.filePath, schema: CacheFileSchema, fallback: { version: 1, entries: [] }, ...(input.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: input.lockDeadlineMs }) })
  let loadedVersion: string | undefined
  let memory = new Map<string, JudgeVerdict>()
  const load = (): Map<string, JudgeVerdict> => {
    const version = fileVersion(input.filePath)
    if (version === loadedVersion) return memory
    try {
      memory = new Map(store.read().entries.map(entry => [entry.key, entry.verdict]))
    } catch {
      memory = new Map()
    }
    loadedVersion = version
    return memory
  }
  return {
    get: key => load().get(key),
    async set(key, verdict) {
      try {
        await store.update((state) => {
          state.entries = [...state.entries.filter(entry => entry.key !== key), { key, at: new Date().toISOString(), verdict }].slice(-JUDGE_CACHE_LIMIT)
        })
        load().set(key, verdict)
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
