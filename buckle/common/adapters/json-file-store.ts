import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { withFileLock } from '@5straps/runtime/sqlite'
import { ZodError, type z } from 'zod'
import { logger } from '../runtime/log.js'
import { replaceFile, type RenameIo } from './replace-file.js'
import type { ServiceFailure } from '../types/service-failure.js'

/** Temporary contention on Buckle's state: HTTP answers 503 so the caller retries. */
export const STATE_BUSY = 'STATE_BUSY'

/** A state file that exists but cannot be used; the message names the file and the invalid fields, never a value. */
export class StateFileError extends Error {
  // Named, so a log line that keeps only an error's name and own message says which failure it was.
  override readonly name = 'StateFileError'
  /** The store already logged this failure of this version of the file, so a caller's own warning need not repeat it. */
  readonly repeated: boolean

  constructor(message: string, options: { repeated: boolean }) {
    super(message)
    this.repeated = options.repeated
  }
}

/**
 * Whether a failure is a state file the store already reported unreadable, unchanged since: a timed retry that meets it
 * again stays quiet (slice 7c review R7C-TL-3).
 */
export function alreadyReported(error: unknown): boolean {
  return error instanceof StateFileError && error.repeated
}

/** Another process held the state file's lock past the wait; HTTP answers 503, the CLI exits 1. */
export class StateBusyError extends Error implements ServiceFailure {
  readonly code = STATE_BUSY
  readonly status = 503
}

// Same bound as the busy timeout it replaces, now polled so the event loop keeps running.
const LOCK_DEADLINE_MS = 5_000
const LOCK_POLL_MS = 25

export { replaceFile, type RenameIo }

export interface JsonFileStore<T> {
  /**
   * Lock-free: every write is an atomic rename. An unreadable file's error line is logged once for each failure of each
   * version of the file, until a read succeeds, whichever caller reads it (slice 7b review RRL-2, slice 7c review
   * R7C-TL-3).
   */
  read(): T
  write(value: T): Promise<void>
  /**
   * Read, change and persist under the file lock. A change that awaits keeps the lock meanwhile, so keep it short.
   * `commit` persists the state as the change has it so far, the lock still held, for work that must follow a write.
   * `persisted` runs once the last write is on disk, before the lock is released, which may still fail after it.
   */
  update<R>(change: (state: T, commit: () => Promise<void>) => R | Promise<R>, persisted?: () => void): Promise<R>
  /** Runs `operation` under the file lock without reading the file, so it takes its turn with updates even while the file cannot be read. */
  locked<R>(operation: () => R | Promise<R>): Promise<R>
}

// One queue per state file in this process: local flows take turns here, and only other processes
// contend for the file lock.
const turns = new Map<string, Promise<unknown>>()
// The turns the current async flow was started under. A timer or promise created inside an update
// inherits this too, so a turn counts as held only while its update is still running.
interface Turn { readonly key: string; active: boolean }
const heldTurns = new AsyncLocalStorage<readonly Turn[]>()

function inTurn<R>(key: string, operation: () => Promise<R>): Promise<R> {
  const held = heldTurns.getStore() ?? []
  // An update nested in a running update of the same file would wait for itself.
  if (held.some(turn => turn.key === key && turn.active)) return Promise.reject(new Error(`State file ${key} is already being updated by this operation; nested updates are not supported`))
  const turn: Turn = { key, active: true }
  const result = (turns.get(key) ?? Promise.resolve()).then(() => heldTurns.run([...held.filter(other => other.active), turn], async () => {
    try {
      return await operation()
    } finally {
      turn.active = false
    }
  }))
  const settled = result.then(() => undefined, () => undefined)
  turns.set(key, settled)
  void settled.then(() => { if (turns.get(key) === settled) turns.delete(key) })
  return result
}

/**
 * Runs `operation` once this process's earlier operations on the file are done, under the file's cross-process lock in
 * `<file>.lock.sqlite`; another process holding it past the wait answers StateBusyError.
 */
export function withFileTurn<R>(input: { filePath: string; lockDeadlineMs?: number }, operation: () => R | Promise<R>): Promise<R> {
  return inTurn(resolve(input.filePath), async () => {
    // SQLite supplies an OS-released cross-process lock; the file keeps its own format.
    const wait = { deadlineMs: input.lockDeadlineMs ?? LOCK_DEADLINE_MS, pollMs: LOCK_POLL_MS }
    try {
      return await withFileLock({ path: `${input.filePath}.lock.sqlite`, wait }, async () => operation())
    } catch (error) {
      if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw new StateBusyError(`${input.filePath} is busy in another Buckle process; retry shortly`, { cause: error })
      throw error
    }
  })
}

/**
 * `silent` is for a look that leaves an unreadable file to the store that opens it for real: the failure is thrown, not
 * logged, so the owner reads one line for it and not one from each store (mounts follow-up, second fix round, item F5).
 */
export function createJsonFileStore<T>(input: { filePath: string; schema: z.ZodType<T>; fallback: T; lockDeadlineMs?: number; silent?: boolean }): JsonFileStore<T> {
  // The failure last logged, with the file's version: met again, it is thrown without a second line. A mode put back
  // keeps the version, so only a read that succeeds forgets it, and a new damage after that is logged again.
  let reported: string | undefined

  function read(): T {
    try {
      const value = input.schema.parse(JSON.parse(readFileSync(input.filePath, 'utf8')))
      reported = undefined
      return value
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        reported = undefined
        return structuredClone(input.fallback)
      }
      const fields = invalidFields(error)
      const reason = failureKind(error)
      const failure = `${fileVersion(input.filePath)} ${reason} ${fields ?? ''}`
      const repeated = failure === reported
      if (!repeated && !input.silent) logger.error('State file cannot be read safely', { filePath: input.filePath, reason, ...(fields ? { fields } : {}) })
      reported = failure
      // No cause: a parse error's message quotes the file around the fault, and every log site that meets this error
      // would follow it (slice 7b review RRL-1). This line and the one above name the file, the kind and the fields.
      throw new StateFileError(`State file is unreadable or invalid: ${input.filePath}${fields ? ` at ${fields}` : ''}; owner repair is required`, { repeated })
    }
  }

  function locked<R>(operation: () => R | Promise<R>): Promise<R> {
    return withFileTurn({ filePath: input.filePath, lockDeadlineMs: input.lockDeadlineMs }, operation)
  }

  async function persist(value: T): Promise<void> {
    const validated = input.schema.parse(value)
    const temporary = `${input.filePath}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      await replaceFile(temporary, input.filePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  return {
    read,
    locked,
    write: value => locked(() => persist(value)),
    update: (change, persisted) => locked(async () => {
      const state = read()
      const result = await change(state, () => persist(state))
      await persist(state)
      persisted?.()
      return result
    }),
  }
}

/**
 * A file's device, inode, modification time and size, so a file replaced or rewritten reads as another version;
 * `missing` when it does not exist, and `unknown:<code>` when it cannot be stat'ed (a directory that lost its search
 * permission), never a throw. Shared with the approvals queue's version (slice 7d review R7D-GR-1).
 */
export function fileVersion(filePath: string): string {
  try {
    const stats = statSync(filePath, { throwIfNoEntry: false })
    return stats ? `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}` : 'missing'
  } catch (error) {
    return `unknown:${failureKind(error)}`
  }
}

/** What kind of failure an unreadable state file is, naming no part of it: a system error code, or the error's name. */
function failureKind(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  return 'code' in error && typeof error.code === 'string' ? error.code : error.name
}

// Field paths only: a value in a state file can be a credential.
function invalidFields(error: unknown): string | undefined {
  if (!(error instanceof ZodError)) return undefined
  return [...new Set(error.issues.map(issue => issue.path.join('.') || '(root)'))].join(', ')
}
