import { createHash } from 'node:crypto'
import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, fileVersion } from '../../adapters/json-file-store.js'
import { logger } from '../../runtime/log.js'
import { JUDGE_LEVELS, type JudgeInput, type JudgeVerdict } from '../../types/ports/judge.js'
import type { QuickVerdict } from '../../types/ports/quick-judge.js'

/** A verdict either stage gave: the thorough stage's carries reasoning, the quick stage's its probabilities. */
export type KeptVerdict = JudgeVerdict | QuickVerdict

/** The most verdicts a workspace keeps; past it the oldest is dropped (D91, addendum B). */
export const JUDGE_CACHE_LIMIT = 1_000

/** How long a verdict is kept (D91, addendum 2 D): an older one is a miss, and the file drops it at its next write. */
export const JUDGE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

const Probability = z.number().min(0).max(1)
const VerdictSchema = z.union([
  z.object({
    kind: z.literal('verdict'), level: z.enum(JUDGE_LEVELS), confidence: Probability,
    reasoning: z.string(), model: z.string(), latencyMs: z.number().nonnegative(), promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal('verdict'), level: z.enum(JUDGE_LEVELS), confidence: Probability,
    probabilities: z.object({ safe: Probability, warning: Probability, danger: Probability }).strict(), model: z.string(), latencyMs: z.number().nonnegative(),
  }).strict(),
])
const EntrySchema = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), at: z.iso.datetime(), verdict: VerdictSchema })
const CacheFileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema).max(JUDGE_CACHE_LIMIT) })
type CacheFile = z.infer<typeof CacheFileSchema>

/** Where a workspace keeps its verdicts: owner-only, beside its other records, under its own state directory. */
export function judgeCachePath(stateDirectory: string): string {
  return join(stateDirectory, 'judge-cache.json')
}

/**
 * What a verdict is kept under (D91, addendum B): the provider and model that gave it, so the two stages never share a key, the policy as it stood (its
 * updatedAt and the lists the judge was shown), the command as shown, its inline code, each file it ran as its sandbox
 * path paired with its sha, sorted, every package with the version installed, whether it was a standard script, where
 * it ran, the places it can reach with their access, the variables the call sets as the stage saw them, and the node's
 * summary of the call (its network access and the files it declares among them). One byte changed in any file the code
 * reads, two files swapping contents, or a mount added or made writable, is a
 * new key, so all of the code is rated again; the order the reader found the files in is not part of it.
 */
export function judgeCacheKey(input: { provider: string; model: string; policyUpdatedAt: string | null; asked: JudgeInput }): string {
  const { asked } = input
  // The path decides which code runs, so a sha is kept with the file that holds it, never alone.
  const files = asked.files.map(file => `${file.path}\0${file.sha256}`).sort()
  const packages = asked.packages.map(item => `${item.name}@${item.version ?? ''}`).sort()
  const env = asked.env.map(item => `${item.name}\0${item.value}`).sort()
  const mounts = asked.mounts.map(mount => `${mount.target}:${mount.access}`).sort()
  return createHash('sha256').update(JSON.stringify([input.provider, input.model, input.policyUpdatedAt, asked.policy, asked.command, asked.inline, files, packages, asked.standardScript, asked.cwd, mounts, env, asked.description])).digest('hex')
}

/**
 * A workspace's kept verdicts, in memory and in judge-cache.json, so a restart keeps them, each for JUDGE_CACHE_TTL_MS
 * from when it was given; the file is read again whenever another process changed it (`buckle workspace judge-cache
 * clear`). Only a verdict is kept, never an unavailable rating. A cache that cannot be read or written fails no call: the judge is asked again, and the owner's
 * log says why once.
 */
export interface JudgeCache {
  get(key: string): KeptVerdict | undefined
  set(key: string, verdict: KeptVerdict): Promise<void>
  /** Empties it, returning how many verdicts it held. */
  clear(): Promise<number>
}

export function openJudgeCache(input: { filePath: string; lockDeadlineMs?: number; now?: () => number }): JudgeCache {
  const now = input.now ?? Date.now
  const fresh = (at: number) => now() - at < JUDGE_CACHE_TTL_MS
  const store = createJsonFileStore<CacheFile>({ filePath: input.filePath, schema: CacheFileSchema, fallback: { version: 1, entries: [] }, ...(input.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: input.lockDeadlineMs }) })
  let loadedVersion: string | undefined
  let memory = new Map<string, { verdict: KeptVerdict; at: number }>()
  const load = (): Map<string, { verdict: KeptVerdict; at: number }> => {
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
