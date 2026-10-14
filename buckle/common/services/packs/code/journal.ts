import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs'
import { join } from 'pathe'
import { z } from 'zod'
import { JsonObjectSchema, JsonValueSchema } from '@5straps/protocol'
import { replaceFile } from '../../../adapters/json-file-store.js'
import { setMode } from '../../../adapters/file-modes.js'
import { workspaceStateKey } from '../../../domain/workspace-key.js'
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
/**
 * The most one journal holds; a script whose results pass it cannot be resumed, and its journal keeps its calls as
 * stubs, their results dropped, so none runs again (final review of 0.1.4, finding docs code-mode-02.md:19).
 */
export const JOURNAL_BYTES = 32 * 1_024 * 1_024
/** The most a workspace's journals hold together; the oldest go first. */
export const WORKSPACE_JOURNAL_BYTES = 128 * 1_024 * 1_024
export const CODE_REPLAY_TOO_LARGE = 'CODE_REPLAY_TOO_LARGE'
/** How long a temporary file is left to the write that made it before a sweep counts it as left over from a crash. */
export const TEMPORARY_GRACE_MS = 60_000
const JOURNAL_FILE = /^[0-9a-f]{64}\.json$/
const TEMPORARY_FILE = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/

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

const RunToolSchema = z.object({ name: z.string(), jsName: z.string(), description: z.string(), inputSchema: JsonObjectSchema })

const GlobalEntrySchema = z.object({
  seq: z.number().int().positive(),
  id: z.number().int().positive(),
  /** The global, `describeTool` or `searchTools`. */
  name: z.string(),
  /** Its arguments, hashed as a tool call's are. */
  args: z.string(),
})

const UnansweredEntrySchema = z.object({
  id: z.number().int().positive(),
  tool: z.string(),
  /** Its arguments, hashed as an entry's are. */
  args: z.string(),
})

const JournalSchema = z.object({
  version: z.literal(1),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: z.number().nonnegative(),
  seed: z.number().int().nonnegative(),
  /** The VM the run started on (ScriptVmRunInput.onStarted); a replay on another is refused. */
  vm: z.string().optional(),
  /**
   * The script itself, which the audit log keeps only the size of, and the tokens of the asks it stopped at: what
   * `buckle approvals show <token>` prints for an approver (review of the code-mode slice, coordinator decision 4).
   */
  script: z.string().optional(),
  asks: z.array(z.string()).optional(),
  /**
   * The requestId of the first run's code_run call, which its calls name as their parent and a resumed run keeps
   * (finding docs-rules code-mode.md:111; final review of 0.1.4, finding invoker 701).
   */
  parentRequestId: z.string().optional(),
  /** The run's tools; each input schema, so describeTool answers a replay from the run's own list (recheck 2, code index.ts:363). */
  tools: z.array(RunToolSchema),
  entries: z.array(EntrySchema),
  /**
   * Each describeTool and searchTools call, its number and its arguments' fingerprint alone, never its answer, kept
   * apart from the entries and their bound: a replay answers a global again only where these match (recheck 2 of the
   * final review of 0.1.4, finding code index.ts:363).
   */
  globals: z.array(GlobalEntrySchema).optional(),
  /**
   * Each tool call a run made that no entry answers, one that asked, was cut before it ran, or never started: its
   * number, tool, and arguments' fingerprint, no result, kept apart from the entries and their bound. A replay makes
   * it live again only with the same fingerprint (recheck 4 of the final review of 0.1.4, finding code index.ts:444).
   */
  unanswered: z.array(UnansweredEntrySchema).optional(),
  expiresAt: z.number(),
})

export type Journal = z.infer<typeof JournalSchema>
export type JournalEntry = z.infer<typeof EntrySchema>
export type GlobalEntry = z.infer<typeof GlobalEntrySchema>
export type UnansweredEntry = z.infer<typeof UnansweredEntrySchema>
export type RunTool = z.infer<typeof RunToolSchema>

/** Where a workspace's journals are kept: `<state>/code-journal/<workspace key>`, under the state every sandbox hides. */
export function journalDirectory(input: { stateDirectory: string; cwd: string }): string {
  return join(input.stateDirectory, 'code-journal', workspaceStateKey(input.cwd))
}

/**
 * The text of the script that stopped at the ask `token`, from the journal written at that ask while it is kept, or
 * null. Read for an approver, the owner, never for an agent; a journal that cannot be read is passed over.
 */
export function scriptOfAsk(directory: string, token: string, now = Date.now()): string | null {
  let names: string[]
  try {
    names = readdirSync(directory).filter(name => JOURNAL_FILE.test(name))
  } catch {
    return null
  }
  for (const name of names) {
    let parsed: ReturnType<typeof JournalSchema.safeParse>
    try {
      parsed = JournalSchema.safeParse(JSON.parse(readFileSync(join(directory, name), 'utf8')))
    } catch {
      continue
    }
    if (parsed.success && parsed.data.expiresAt > now && parsed.data.script !== undefined && parsed.data.asks?.includes(token)) return parsed.data.script
  }
  return null
}

export interface JournalStore {
  /** The script's journal, or null when it has none or it expired (an expired one is removed). */
  read(key: string): Journal | null
  /**
   * Writes it whole, expiring JOURNAL_TTL_MS from now, or at `expiresAt` for a record rewritten as kept; false when its
   * entries pass JOURNAL_BYTES and it was not kept.
   */
  write(journal: Omit<Journal, 'expiresAt' | 'version'>, options?: { expiresAt?: number }): Promise<boolean>
  remove(key: string): void
}

export function createJournalStore(input: { directory: string; now?: () => number; journalBytes?: number; workspaceBytes?: number }): JournalStore {
  const now = input.now ?? (() => Date.now())
  const journalBytes = input.journalBytes ?? JOURNAL_BYTES
  const workspaceBytes = input.workspaceBytes ?? WORKSPACE_JOURNAL_BYTES
  const pathOf = (key: string) => join(input.directory, `${key}.json`)

  function remove(key: string): void {
    rmSync(pathOf(key), { force: true })
  }

  /**
   * Expired journals go, and temporary files a crashed write left, then the oldest until the workspace's journals fit
   * their bound. Run when the store opens and at every write, so a journal nobody resumes, which holds tool results,
   * is not kept past its ten minutes for want of a later ask (review of the code-mode slice, findings sandbox-boundary
   * journal.ts:134 and :121).
   */
  function prune(): void {
    let names: string[]
    try {
      names = readdirSync(input.directory)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const files = names.flatMap((name) => {
      const temporary = TEMPORARY_FILE.test(name)
      if (!temporary && !JOURNAL_FILE.test(name)) return []
      const path = join(input.directory, name)
      const stat = statSync(path, { throwIfNoEntry: false })
      return stat ? [{ path, bytes: stat.size, at: stat.mtimeMs, lifetime: temporary ? TEMPORARY_GRACE_MS : JOURNAL_TTL_MS }] : []
    }).sort((left, right) => left.at - right.at)
    let total = files.reduce((sum, file) => sum + file.bytes, 0)
    for (const file of files) {
      if (file.at + file.lifetime > now() && total <= workspaceBytes) continue
      rmSync(file.path, { force: true })
      total -= file.bytes
    }
  }

  prune()

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

    async write(journal, options = {}) {
      const expiresAt = options.expiresAt ?? now() + JOURNAL_TTL_MS
      const text = JSON.stringify({ version: 1, ...journal, expiresAt } satisfies Journal)
      // The bound measures the entries' text alone, as the run's own does: the script, the tools, and the globals,
      // which MAX_GLOBAL_CALLS bounds, add their own size on top (recheck 3 of the final review of 0.1.4, finding
      // journal.ts:197).
      if (Buffer.byteLength(JSON.stringify(journal.entries)) > journalBytes) {
        remove(journal.key)
        return false
      }
      mkdirSync(input.directory, { recursive: true, mode: 0o700 })
      setMode(input.directory, 0o700)
      const temporary = join(input.directory, `.${journal.key}.${randomUUID()}.tmp`)
      // A write that fails anywhere, the disk full or the rename refused, leaves no part of its tool results behind.
      try {
        const descriptor = openSync(temporary, 'wx', 0o600)
        try {
          writeSync(descriptor, text)
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        await replaceFile(temporary, pathOf(journal.key))
        // A record rewritten with its old expiry keeps its age, so the sweep that goes by file times agrees with it.
        if (options.expiresAt !== undefined) {
          const madeAt = (options.expiresAt - JOURNAL_TTL_MS) / 1_000
          utimesSync(pathOf(journal.key), madeAt, madeAt)
        }
      } finally {
        rmSync(temporary, { force: true })
        prune()
      }
      return true
    },

    remove,
  }
}
