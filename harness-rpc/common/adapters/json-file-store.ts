import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { withFileLock } from '@5straps/runtime/sqlite'
import { ZodError, type z } from 'zod'
import { logger } from '../runtime/log.js'
import type { ServiceFailure } from '../types/service-failure.js'

/** Temporary contention on Buckle's state: HTTP answers 503 so the caller retries. */
export const STATE_BUSY = 'STATE_BUSY'

/** A state file that exists but cannot be used; the message names the file and the invalid fields, never a value. */
export class StateFileError extends Error {}

/** Another process held the state file's lock past the wait; HTTP answers 503, the CLI exits 1. */
export class StateBusyError extends Error implements ServiceFailure {
  readonly code = STATE_BUSY
  readonly status = 503
}

// Same bound as the busy timeout it replaces, now polled so the event loop keeps running.
const LOCK_DEADLINE_MS = 5_000
const LOCK_POLL_MS = 25

export interface JsonFileStore<T> {
  /** Lock-free: every write is an atomic rename. */
  read(): T
  write(value: T): Promise<void>
  /** Read, change and persist under the file lock. A change that awaits keeps the lock meanwhile, so keep it short. */
  update<R>(change: (state: T) => R | Promise<R>): Promise<R>
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

export function createJsonFileStore<T>(input: { filePath: string; schema: z.ZodType<T>; fallback: T; lockDeadlineMs?: number }): JsonFileStore<T> {
  function read(): T {
    try {
      return input.schema.parse(JSON.parse(readFileSync(input.filePath, 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return structuredClone(input.fallback)
      const fields = invalidFields(error)
      logger.error('State file cannot be read safely', { filePath: input.filePath, ...(fields ? { fields } : {}) })
      throw new StateFileError(`State file is unreadable or invalid: ${input.filePath}${fields ? ` at ${fields}` : ''}; owner repair is required`, { cause: error })
    }
  }

  function locked<R>(operation: () => R | Promise<R>): Promise<R> {
    return inTurn(resolve(input.filePath), async () => {
      // SQLite supplies an OS-released cross-process lock; JSON remains the data format.
      const wait = { deadlineMs: input.lockDeadlineMs ?? LOCK_DEADLINE_MS, pollMs: LOCK_POLL_MS }
      try {
        return await withFileLock({ path: `${input.filePath}.lock.sqlite`, wait }, async () => operation())
      } catch (error) {
        if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw new StateBusyError(`State file ${input.filePath} is busy in another Buckle process; retry shortly`, { cause: error })
        throw error
      }
    })
  }

  function persist(value: T): void {
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
      renameSync(temporary, input.filePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  return {
    read,
    write: value => locked(() => persist(value)),
    update: change => locked(async () => {
      const state = read()
      const result = await change(state)
      persist(state)
      return result
    }),
  }
}

// Field paths only: a value in a state file can be a credential.
function invalidFields(error: unknown): string | undefined {
  if (!(error instanceof ZodError)) return undefined
  return [...new Set(error.issues.map(issue => issue.path.join('.') || '(root)'))].join(', ')
}
