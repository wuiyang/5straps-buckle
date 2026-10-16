import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'pathe'
import { z } from 'zod'
import { isRuntimeError, RuntimeErrorCode, type RuntimeOwner } from '@5straps/runtime'
import { acquireFileLock, acquireOwnershipLock } from '@5straps/runtime/sqlite'
import { replaceFile } from '../../adapters/json-file-store.js'

/**
 * What started a serving process that runs on with no terminal (Phase 3 of the workspace-model slice): the systemd
 * user unit, the Windows Task Scheduler task, or `buckle serve --background` by hand.
 */
export const SERVICE_MANAGERS = ['systemd', 'task-scheduler', 'background'] as const
export type ServiceManagerKind = typeof SERVICE_MANAGERS[number]

/** Where a node's service files live: owner-only, inside the state directory, so no agent tool reads or writes them. */
export function serviceDirectory(stateDirectory: string): string {
  return join(stateDirectory, 'service')
}

/** The Windows task's definition as Buckle wrote it, kept in the state directory, where no agent tool reads or writes it. */
export function taskDefinitionCopy(stateDirectory: string): string {
  return join(serviceDirectory(stateDirectory), 'task.xml')
}

/** The one rotating log a node running with no terminal writes, inside the state directory. */
export function serviceLogPath(stateDirectory: string): string {
  return join(stateDirectory, 'logs', 'buckle.log')
}

const RECORD_FILE = 'serve.json'
const LOCK_FILE = 'serve.lock.sqlite'
const STOP_FILE = 'stop-request'
/**
 * How long a starting service waits for the lock. A process that serves holds it for its life, so this only rides out a
 * `buckle service status` or a `buckle serve` that takes it for an instant to see whether one serves.
 */
const LOCK_WAIT_MS = 2_000
const STOP_POLL_MS = 1_000

/** What a serving process with no terminal records once it listens, read by `buckle service status` and `buckle serve`. */
export const ServeRecordSchema = z.object({
  pid: z.number().int().positive(),
  manager: z.enum(SERVICE_MANAGERS),
  version: z.string(),
  host: z.string(),
  port: z.number().int().nonnegative(),
  startedAt: z.string(),
}).strict()
export type ServeRecord = z.infer<typeof ServeRecordSchema>

/** What `buckle serve` and `buckle service` see of a node already serving with no terminal; null where none serves. */
export interface RunningNode {
  /** Its record, or null in the instant between taking the lock and listening, or where the record cannot be read. */
  record: ServeRecord | null
}

export const ALREADY_SERVING = 'Buckle is already running in service mode'

export class AlreadyServingError extends Error {
  override readonly name = 'AlreadyServingError'
}

/** A serving process's hold on its state directory: the lock for its life, and the record it writes once it listens. */
export interface ServeHold {
  publish(record: Omit<ServeRecord, 'pid' | 'startedAt'>): Promise<void>
}

/**
 * Takes the state directory's serve lock for this process's life, released at the owner's `locks` stage (the OS drops
 * it if the process dies, so a killed node leaves no stale lock), and clears a stop request an earlier process left.
 * Refused, as AlreadyServingError, where another process holds it. The record is removed before the lock is released.
 */
export async function holdServe(input: { stateDirectory: string; owner: RuntimeOwner }): Promise<ServeHold> {
  const directory = serviceDirectory(input.stateDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    await acquireLockWithin({ path: join(directory, LOCK_FILE), owner: input.owner })
  } catch (error) {
    if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw new AlreadyServingError(ALREADY_SERVING)
    throw error
  }
  rmSync(join(directory, STOP_FILE), { force: true })
  const record = join(directory, RECORD_FILE)
  input.owner.onClose('locks', 'serve record', () => {
    if (readRecord(input.stateDirectory)?.pid === process.pid) rmSync(record, { force: true })
  })
  return {
    publish: fields => writeOwnerOnly(record, `${JSON.stringify(ServeRecordSchema.parse({ ...fields, pid: process.pid, startedAt: new Date().toISOString() }), null, 2)}\n`),
  }
}

async function acquireLockWithin(input: { path: string; owner: RuntimeOwner }): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await acquireOwnershipLock({ path: input.path, owner: input.owner })
      return
    } catch (error) {
      if (!isRuntimeError(error, RuntimeErrorCode.lockBusy) || Date.now() >= deadline) throw error
      await delay(50)
    }
  }
}

/** The node serving this state directory with no terminal, read without waiting; null where none holds the lock. */
export async function runningNode(stateDirectory: string): Promise<RunningNode | null> {
  const path = join(serviceDirectory(stateDirectory), LOCK_FILE)
  if (!existsSync(path)) return null
  try {
    const lock = await acquireFileLock({ path, wait: 'none' })
    await lock.release()
    return null
  } catch (error) {
    if (!isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw error
  }
  return { record: readRecord(stateDirectory) }
}

/** The record a serving process wrote, or null where there is none or it will not parse. */
export function readRecord(stateDirectory: string): ServeRecord | null {
  try {
    return ServeRecordSchema.parse(JSON.parse(readFileSync(join(serviceDirectory(stateDirectory), RECORD_FILE), 'utf8')))
  } catch {
    return null
  }
}

/**
 * Asks the process `pid` to stop: a file it polls for, as Windows delivers a service no SIGTERM. Only a request naming
 * its own pid is taken, so one an earlier stop left never ends a later process.
 */
export async function requestStop(stateDirectory: string, pid: number): Promise<void> {
  const directory = serviceDirectory(stateDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  await writeOwnerOnly(join(directory, STOP_FILE), `${JSON.stringify({ pid, requestedAt: new Date().toISOString() })}\n`)
}

/** Calls `onStop` once a stop request naming this process appears, polled on a timer that never holds the process open. */
export function watchStopRequest(input: { stateDirectory: string; onStop: () => void; intervalMs?: number; pid?: number }): () => void {
  const file = join(serviceDirectory(input.stateDirectory), STOP_FILE)
  const pid = input.pid ?? process.pid
  const timer = setInterval(() => {
    if (requestedPid(file) !== pid) return
    rmSync(file, { force: true })
    clearInterval(timer)
    input.onStop()
  }, input.intervalMs ?? STOP_POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

function requestedPid(file: string): number | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
    return typeof value.pid === 'number' ? value.pid : null
  } catch {
    return null
  }
}

/** Waits until no process serves the state directory, or `timeoutMs` passes; true once it has stopped. */
export async function waitForStop(stateDirectory: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await runningNode(stateDirectory) === null) return true
    if (Date.now() >= deadline) return false
    await delay(100)
  }
}

/**
 * Waits for a serving process's record, the one `pid` wrote where it is given, until `timeoutMs` passes or `gone` says
 * the process ended; null where none came.
 */
export async function waitForRecord(input: { stateDirectory: string; pid?: number; timeoutMs: number; gone?: () => boolean }): Promise<ServeRecord | null> {
  const deadline = Date.now() + input.timeoutMs
  for (;;) {
    const record = readRecord(input.stateDirectory)
    if (record !== null && (input.pid === undefined || record.pid === input.pid)) return record
    if (input.gone?.() || Date.now() >= deadline) return null
    await delay(100)
  }
}

async function writeOwnerOnly(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    await replaceFile(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
