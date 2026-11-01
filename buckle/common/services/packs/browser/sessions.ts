import { randomUUID } from 'node:crypto'
import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, type JsonFileStore } from '../../../adapters/json-file-store.js'
import type { BrowserModeName } from './mode.js'

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
  closing: z.literal(true).optional(),
})

export type BrowserRecord = z.infer<typeof BrowserRecordSchema>
export type Writer = z.infer<typeof WriterSchema>

export const SessionsSchema = z.object({
  browsers: z.record(z.string(), BrowserRecordSchema).default({}),
  /**
   * Each value a fill or type handed a browser of the workspace from a secret reference (docs/secrets.md), by file, NAME,
   * and sha256, never the value, so every Buckle process on the workspace masks the page by it, after a restart too;
   * absent while none is held.
   */
  filled: z.array(FilledSchema).optional(),
  // The store of Buckle 0.1.9 and before, keyed by caller and settings: taken up once (upgradeSessions) and kept empty,
  // so an earlier Buckle still reads the file.
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

export function writerOf(instance: string): Writer {
  return { pid: process.pid, instance }
}

export function isWriter(record: BrowserRecord, me: Writer): boolean {
  return record.writer.pid === me.pid && record.writer.instance === me.instance
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

/** Whether another live Buckle process wrote the record: its session is that process's to keep. */
export function liveSibling(record: BrowserRecord, me: Writer): boolean {
  return record.writer.pid !== me.pid && processAlive(record.writer.pid)
}

const KINDS = new Set<string>(['fresh', 'profile', 'attached'])

/**
 * Takes up the store an earlier Buckle wrote, keyed by caller and settings, as records by session name, and empties
 * it. Its writer is a pid alone, so the instance is unknown; it was last used at an unknown time, 0.
 */
export function upgradeSessions(state: Sessions): void {
  for (const [key, session] of Object.entries(state.sessions)) {
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
    }
  }
  state.sessions = {}
  state.allowedDomains = {}
  state.modes = {}
  state.writers = {}
}

/** The session names a record set holds that match `test`. */
export function recordsWhere(state: Sessions, test: (record: BrowserRecord, name: string) => boolean): string[] {
  return Object.entries(state.browsers).flatMap(([name, record]) => (test(record, name) ? [name] : []))
}
