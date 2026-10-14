import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'pathe'
import { z } from 'zod'
import { JsonObjectSchema, JsonValueSchema } from '@5straps/protocol'
import { replaceFile } from '../../../adapters/json-file-store.js'
import { setMode } from '../../../adapters/file-modes.js'
import { logger } from '../../../runtime/log.js'
import { EXECUTION_TTL_MS } from '../../invocation/executions.js'

/**
 * The replay journal of a script that stopped at an ask (owner decision D82, point 7): its clock start, seed, the
 * tools it was handed, and every result delivered to it in order, so the retry after the answer replays those and
 * runs only what comes after. Kept on disk because asks survive a restart (owner decision D4) and a call must never
 * run twice; under the workspace's state directory, which every sandbox hides, because results may hold file
 * contents. One file per script, `<key>.json`, the key naming the session, the actor, and the script.
 */
export const JOURNAL_TTL_MS = EXECUTION_TTL_MS
/** The most one journal holds; a script whose results pass it cannot be resumed after an ask. */
export const JOURNAL_BYTES = 32 * 1_024 * 1_024
/** The most a workspace's journals hold together; the oldest go first. */
export const WORKSPACE_JOURNAL_BYTES = 128 * 1_024 * 1_024
export const CODE_REPLAY_TOO_LARGE = 'CODE_REPLAY_TOO_LARGE'

const OutcomeSchema = z.union([
  z.object({ ok: z.literal(true), value: JsonValueSchema.optional() }),
  z.object({ ok: z.literal(false), message: z.string(), properties: JsonObjectSchema.optional() }),
])

const EntrySchema = z.object({
  seq: z.number().int().positive(),
  now: z.number(),
  id: z.number().int().positive(),
  /** The tool, or `global:<name>` for a global such as describeTool. */
  tool: z.string(),
  /** The call's tool and canonical arguments, hashed (requestFingerprint). */
  args: z.string(),
  outcome: OutcomeSchema,
})

const JournalSchema = z.object({
  version: z.literal(1),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: z.number().nonnegative(),
  seed: z.number().int().nonnegative(),
  /** The VM the run started on (ScriptVmRunInput.onStarted); a replay on another is refused. */
  vm: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), jsName: z.string(), description: z.string() })),
  entries: z.array(EntrySchema),
  expiresAt: z.number(),
})

export type Journal = z.infer<typeof JournalSchema>
export type JournalEntry = z.infer<typeof EntrySchema>

export interface JournalStore {
  /** The script's journal, or null when it has none or it expired (an expired one is removed). */
  read(key: string): Journal | null
  /** Writes it whole, expiring JOURNAL_TTL_MS from now; false when it passes JOURNAL_BYTES and was not kept. */
  write(journal: Omit<Journal, 'expiresAt' | 'version'>): Promise<boolean>
  remove(key: string): void
}

export function createJournalStore(input: { directory: string; now?: () => number; journalBytes?: number; workspaceBytes?: number }): JournalStore {
  const now = input.now ?? Date.now
  const journalBytes = input.journalBytes ?? JOURNAL_BYTES
  const workspaceBytes = input.workspaceBytes ?? WORKSPACE_JOURNAL_BYTES
  const pathOf = (key: string) => join(input.directory, `${key}.json`)

  function remove(key: string): void {
    rmSync(pathOf(key), { force: true })
  }

  /** Expired journals go, then the oldest until the workspace's journals fit their bound. */
  function prune(): void {
    const files = readdirSync(input.directory).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => {
      const path = join(input.directory, name)
      const stat = statSync(path, { throwIfNoEntry: false })
      return stat ? { path, bytes: stat.size, at: stat.mtimeMs } : null
    }).filter(file => file !== null).sort((left, right) => left.at - right.at)
    let total = files.reduce((sum, file) => sum + file.bytes, 0)
    for (const file of files) {
      if (file.at + JOURNAL_TTL_MS > now() && total <= workspaceBytes) continue
      rmSync(file.path, { force: true })
      total -= file.bytes
    }
  }

  return {
    read(key) {
      let text: string
      try {
        text = readFileSync(pathOf(key), 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
      }
      const parsed = JournalSchema.safeParse((() => { try { return JSON.parse(text) } catch { return null } })())
      if (!parsed.success || parsed.data.key !== key) {
        // Named by the field paths alone: a journal holds tool results, which may hold file contents.
        logger.warn('A code mode replay journal could not be read; the script runs from its start', { fields: parsed.success ? 'key' : [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '(root)'))].join(', ') })
        remove(key)
        return null
      }
      if (parsed.data.expiresAt <= now()) {
        remove(key)
        return null
      }
      return parsed.data
    },

    async write(journal) {
      const text = JSON.stringify({ version: 1, ...journal, expiresAt: now() + JOURNAL_TTL_MS } satisfies Journal)
      if (Buffer.byteLength(text) > journalBytes) {
        remove(journal.key)
        return false
      }
      mkdirSync(input.directory, { recursive: true, mode: 0o700 })
      setMode(input.directory, 0o700)
      const temporary = join(input.directory, `.${journal.key}.${randomUUID()}.tmp`)
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeSync(descriptor, text)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      try {
        await replaceFile(temporary, pathOf(journal.key))
      } catch (error) {
        rmSync(temporary, { force: true })
        throw error
      }
      prune()
      return true
    },

    remove,
  }
}
