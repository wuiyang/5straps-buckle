import { randomUUID } from 'node:crypto'
import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, type JsonFileStore } from '../../../adapters/json-file-store.js'
import type { FilledSecret } from '../../../domain/tool.js'
import { DEFAULT_IDLE_TIMEOUT_MS, type BrowserModeName } from './mode.js'

const FilledSchema = z.object({ real: z.string(), written: z.string(), name: z.string(), digest: z.string() })

/** The Buckle process that last wrote a record: its pid, and the instance it was, as a pid can come back. */
const WriterSchema = z.object({ pid: z.number().int(), instance: z.string() })

/**
 * One browser session Buckle started, by its agent-browser session name: the caller, stage, and alias it serves (one
 * session for every caller on a profile folder), the settings its daemon started under, the list it last ran with,
 * who last wrote it, and when it was last used. `closing` marks one a close was sent to, which no call takes.
 */
const BrowserRecordSchema = z.object({
  kind: z.enum(['fresh', 'profile', 'attached']),
  caller: z.string(),
  stage: z.string(),
  alias: z.string(),
  /** modeFingerprint of the settings the daemon started with: one started under others is closed and a new one named. */
  mode: z.string(),
  /** The --allowed-domains it last ran with, null for none, absent until a command ran: a change relaunches it. */
  allowedDomains: z.string().nullable().optional(),
  writer: WriterSchema,
  /** When a call last took it, in milliseconds since the epoch. */
  usedAt: z.number(),
  /** The idle timeout its daemon started with: a session unused for longer, and the longest call, has ended. */
  idleTimeoutMs: z.number().int().positive(),
  closing: z.literal(true).optional(),
  /**
   * Each value a fill or type handed this browser from a secret reference (docs/secrets.md), by file, NAME, and sha256,
   * never the value, so every Buckle process masks the page by it, after a restart too; it ends with the browser.
   */
  held: z.array(FilledSchema).optional(),
})

export type BrowserRecord = z.infer<typeof BrowserRecordSchema>
export type Writer = z.infer<typeof WriterSchema>

export const SessionsSchema = z.object({
  browsers: z.record(z.string(), BrowserRecordSchema).default({}),
  /**
   * What each attached Chrome was filled with, by the Chrome its endpoint reaches (attachedChrome), held as `held` is: a
   * close or a shutdown only disconnects from it, and it keeps its pages, so its hold stays until the owner's buckle
   * browser close. A call is masked by its own Chrome's alone (Codex review L6).
   */
  chromes: z.record(z.string(), z.array(FilledSchema)).optional(),
  /** A hold an earlier Buckle kept for an attached Chrome it did not name: every attached Chrome's calls are masked by it. */
  attached: z.array(FilledSchema).optional(),
  // The store of Buckle 0.1.9 and before, keyed by caller and settings: taken up once (upgradeSessions) and kept empty,
  // so an earlier Buckle still reads the file. Its hold was the workspace's, whichever browser was filled.
  filled: z.array(FilledSchema).optional(),
  sessions: z.record(z.string(), z.string()).default({}),
  allowedDomains: z.record(z.string(), z.string().nullable()).default({}),
  modes: z.record(z.string(), z.string()).default({}),
  writers: z.record(z.string(), z.number().int()).default({}),
})

export type Sessions = z.infer<typeof SessionsSchema>

/** A fresh record each time, as a store's update may change the fallback it was handed. */
function emptySessions(): Sessions {
  return { browsers: {}, sessions: {}, allowedDomains: {}, modes: {}, writers: {} }
}

export function sessionsStore(sessionDirectory: string): JsonFileStore<Sessions> {
  return createJsonFileStore({ filePath: join(sessionDirectory, 'sessions.json'), schema: SessionsSchema, fallback: emptySessions() })
}

/** Who a call is for: the caller (the connection's session), its stage, and its alias, each `default` where absent. */
export interface Caller {
  caller: string
  stage: string
  alias: string
}

/** The sessions store's key for the one session every caller shares on a profile folder. */
const SHARED_PROFILE_KEY = JSON.stringify(['profile'])

/**
 * The key a session is kept under: the caller, its stage, and its alias, so Rings stages never share a page, and no
 * settings, which a change replaces under the same key (Slice F4, item 3). Every caller shares one on a profile folder.
 */
export function sessionKey(kind: BrowserModeName, caller: Caller): string {
  return kind === 'profile' ? SHARED_PROFILE_KEY : JSON.stringify([caller.caller, caller.stage, caller.alias])
}

export function keyOf(record: BrowserRecord): string {
  return sessionKey(record.kind, record)
}

/** This Buckle process; a runtime passes its own instance, so two runtimes on one workspace in one process are told apart. */
export const PROCESS_INSTANCE = randomUUID()

/** The instances that run in this process: a runtime holds its own from its pack's start until its shutdown. */
const liveInstances = new Set<string>([PROCESS_INSTANCE])

export function holdInstance(instance: string): void {
  liveInstances.add(instance)
}

export function releaseInstance(instance: string): void {
  if (instance !== PROCESS_INSTANCE) liveInstances.delete(instance)
}

export function writerOf(instance: string): Writer {
  return { pid: process.pid, instance }
}

export function isWriter(record: BrowserRecord, me: Writer): boolean {
  return record.writer.pid === me.pid && record.writer.instance === me.instance
}

/** Whether the writer no longer runs: its process ended, or, on this pid, the instance is not one this process holds. */
export function writerGone(writer: Writer): boolean {
  return writer.pid === process.pid ? !liveInstances.has(writer.instance) : !processAlive(writer.pid)
}

/**
 * Whether a session has ended by its idle timeout: unused for longer than that and the longest call, as its last use is
 * when a call took it, and a call may run that long before the daemon's idle time starts.
 */
export function expired(record: BrowserRecord, now: number, longestCallMs: number): boolean {
  return now - record.usedAt > record.idleTimeoutMs + longestCallMs
}

/** Whether a session is left with no one to end it: its writer stopped, or it outlived its idle timeout. */
export function stranded(record: BrowserRecord, me: Writer, now: number, longestCallMs: number): boolean {
  return (!isWriter(record, me) && writerGone(record.writer)) || expired(record, now, longestCallMs)
}

/**
 * Whether the process that wrote a record still runs. A Buckle sibling runs as the owner, so one Buckle may not signal
 * (EPERM) is another user's, and counts as stopped. A signal of 0 tests and sends nothing.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether another Buckle process, or runtime, still running wrote the record: its session is that one's to keep. */
export function liveSibling(record: BrowserRecord, me: Writer): boolean {
  return !isWriter(record, me) && !writerGone(record.writer)
}

const KINDS = new Set<string>(['fresh', 'profile', 'attached'])

/**
 * Takes up the store an earlier Buckle wrote, keyed by caller and settings, as records by session name, and empties
 * it. Its writer is a pid alone, so the instance is unknown; it was last used at an unknown time, 0. Its hold was the
 * workspace's: each browser it recorded holds it all, and so does an attached Chrome, or, where none is recorded, the
 * attached hold, as only an attached Chrome kept a hold with no browser recorded.
 */
export function upgradeSessions(state: Sessions): void {
  const filled = state.filled ?? []
  const legacy = Object.entries(state.sessions)
  if (filled.length > 0 && (legacy.length === 0 || legacy.some(([key]) => key.startsWith('["attached"')))) state.attached = mergeFilled(state.attached ?? [], filled)
  delete state.filled
  for (const [key, session] of legacy) {
    if (state.browsers[session] !== undefined) continue
    let parts: unknown[]
    try { parts = JSON.parse(key) as unknown[] } catch { parts = [] }
    const kind = typeof parts[0] === 'string' && KINDS.has(parts[0]) ? parts[0] as BrowserModeName : 'fresh'
    const text = (index: number) => typeof parts[index] === 'string' ? parts[index] as string : 'default'
    state.browsers[session] = {
      kind,
      caller: kind === 'profile' ? '' : text(2),
      stage: kind === 'profile' ? 'default' : text(3),
      alias: kind === 'profile' ? 'default' : text(4),
      mode: state.modes[key] ?? '',
      ...(key in state.allowedDomains ? { allowedDomains: state.allowedDomains[key] ?? null } : {}),
      writer: { pid: state.writers[key] ?? 0, instance: '' },
      usedAt: 0,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      ...(filled.length > 0 && kind !== 'attached' ? { held: filled } : {}),
    }
  }
  state.sessions = {}
  state.allowedDomains = {}
  state.modes = {}
  state.writers = {}
}

/**
 * A hold with more values in it, one entry a file, NAME, and digest: a page two fills of one reference reached shows both
 * values, so each is kept until the browser ends (Codex review L4), and a call it can no longer mask by both is refused.
 */
export function mergeFilled(held: readonly FilledSecret[], added: readonly FilledSecret[]): FilledSecret[] {
  const entries = new Map(held.map(entry => [valueKey(entry), entry]))
  for (const entry of added) if (!entries.has(valueKey(entry))) entries.set(valueKey(entry), { real: entry.real, written: entry.written, name: entry.name, digest: entry.digest })
  return [...entries.values()]
}

/** A reference's one value: its file, NAME, and digest. */
function valueKey(entry: FilledSecret): string {
  return `${filledKey(entry)}\u0000${entry.digest}`
}

export function filledKey(entry: FilledSecret): string {
  return `${entry.real}\u0000${entry.name}`
}

/** The session names a record set holds that match `test`. */
export function recordsWhere(state: Sessions, test: (record: BrowserRecord, name: string) => boolean): string[] {
  return Object.entries(state.browsers).flatMap(([name, record]) => (test(record, name) ? [name] : []))
}
