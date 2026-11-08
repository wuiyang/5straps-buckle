import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { settleWithin } from '@5straps/runtime'
import { logger, rootLogLevel, type ForwardedLine } from '../../runtime/log.js'
import type { ActionLogEntry } from '../../types/ports/action-log.js'
import { StateBusyError } from '../json-file-store.js'
import { createPendingAudit } from './pending-audit.js'
import type { LogFile, WorkspaceNaming, WriterFailure, WriterReply, WriterRequest, WriterWorkerData } from './writer-protocol.js'

/** How long readiness waits for the worker to probe a failing log; one that does not answer in time still fails. */
export const PROBE_DEADLINE_MS = 1_000

/** The most writes that wait on the worker at once; past it a write is refused as busy, so its call does not run. */
export const MAX_WAITING_WRITES = 256

/** How long a close waits for the worker to stop once its writes are answered or counted. */
const WORKER_STOP_MS = 250

/** How many entries of failed writes the writer remembers the place of; past it, the oldest is forgotten. */
const PLACES_KEPT = 1_000

/** Ties the attempts this process leaves pending to it, across the worker threads it starts. */
const PROCESS_INSTANCE_ID = randomUUID()

/**
 * The process's one writer of action log files, on a worker thread: the main thread hands it entries and awaits its ack,
 * so a stalled disk holds the callers waiting on their entries and not the node.
 */
export interface ActionLogWriter {
  /**
   * Resolves once every entry is synced to disk and each attempt among them is tracked until its result. Refused as busy
   * while MAX_WAITING_WRITES wait. Entries with an `entryId` that an earlier append to the file failed on are looked for
   * first, from where it began writing, and not written twice; best effort, for a writer that may lose an entry: after a
   * failed sync, a line read back may sit in the page cache alone.
   */
  append(input: { file: LogFile; entries: ActionLogEntry[] }): Promise<void>
  /**
   * Rejects while the log cannot take a write, when the worker does not answer within PROBE_DEADLINE_MS, or at once while
   * the worker has not answered its last probe of the log.
   */
  probe(file: LogFile): Promise<void>
  /** Writes an interrupted result for each attempt whose process stopped before its own; resolves with their count. */
  recover(input: { file: LogFile; naming?: WorkspaceNaming }): Promise<number>
  /**
   * Waits for the writes in flight until the deadline, counts what was left, then stops the worker. A worker held in a
   * disk call stops, and lets the process exit, only once the call returns. A later write starts another worker.
   */
  close(options: { deadlineMs: number }): Promise<{ left: number }>
}

/** The worker's program. A test hands in one on a disk it steers, with the shared memory it steers it by. */
export interface WriterEntry {
  url: URL
  workerData?: Record<string, unknown>
}

interface Waiting { op: WriterRequest['op']; resolve: (value: number | undefined) => void; reject: (error: Error) => void; placed?: (offset: number) => void }
/** `probing`: the file of each probe the worker has not answered, one that timed out included. */
interface Connection { worker: Worker; waiting: Map<number, Waiting>; idle: Array<() => void>; probing: Map<number, string> }

type Operation = { [Op in WriterRequest['op']]: Omit<Extract<WriterRequest, { op: Op }>, 'id'> }[WriterRequest['op']]

let processWriter: ActionLogWriter | undefined

/** The writer every action log of this process shares, started with its first write. */
export function actionLogWriter(): ActionLogWriter {
  processWriter ??= createActionLogWriter()
  return processWriter
}

/** The node's close step: the process's writes in flight get until the deadline. */
export async function closeActionLogWriter(options: { deadlineMs: number }): Promise<{ left: number }> {
  return processWriter ? processWriter.close(options) : { left: 0 }
}

export function createActionLogWriter(options: { entry?: WriterEntry } = {}): ActionLogWriter {
  const entry = options.entry ?? defaultEntry()
  let connection: Connection | undefined
  let nextId = 0
  const places = createPlaces()

  function connect(): Connection {
    if (connection) return connection
    const workerData: WriterWorkerData & Record<string, unknown> = { ...entry.workerData, processInstanceId: PROCESS_INSTANCE_ID, logLevel: rootLogLevel() }
    const worker = new Worker(entry.url, { workerData, ...loaderFor(entry.url) })
    const opened: Connection = { worker, waiting: new Map(), idle: [], probing: new Map() }
    // Idle, the worker never keeps the process alive; a write in flight does.
    worker.unref()
    worker.on('message', (reply: WriterReply) => receive(opened, reply))
    worker.on('error', error => drop(opened, new Error('The action log writer failed', { cause: error })))
    worker.on('exit', code => drop(opened, new Error(`The action log writer stopped with code ${code} before it answered`)))
    connection = opened
    return opened
  }

  function request(operation: Operation, options: { deadlineMs?: number; placed?: (offset: number) => void } = {}): Promise<number | undefined> {
    const opened = connect()
    const id = ++nextId
    const { deadlineMs, placed } = options
    if (operation.op === 'probe') opened.probing.set(id, operation.file.path)
    return new Promise((resolve, reject) => {
      const timer = deadlineMs === undefined ? undefined : setTimeout(() => settle(opened, id)?.reject(new Error('The action log writer did not answer in time')), deadlineMs)
      const clear = () => clearTimeout(timer)
      opened.waiting.set(id, { op: operation.op, resolve: value => { clear(); resolve(value) }, reject: error => { clear(); reject(error) }, ...(placed ? { placed } : {}) })
      opened.worker.ref()
      try {
        opened.worker.postMessage({ ...operation, id } satisfies WriterRequest)
      } catch (error) {
        opened.probing.delete(id)
        settle(opened, id)?.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function receive(opened: Connection, reply: WriterReply): void {
    if (reply.type === 'log') return relayLog(reply.line)
    if (reply.type === 'placed') return opened.waiting.get(reply.id)?.placed?.(reply.offset)
    opened.probing.delete(reply.id)
    const waiting = settle(opened, reply.id)
    if (reply.type === 'done') waiting?.resolve(reply.value)
    else waiting?.reject(failureError(reply.failure))
  }

  function settle(opened: Connection, id: number): Waiting | undefined {
    const waiting = opened.waiting.get(id)
    opened.waiting.delete(id)
    if (opened.waiting.size === 0) {
      opened.worker.unref()
      for (const done of opened.idle.splice(0)) done()
    }
    return waiting
  }

  function drop(opened: Connection, error: Error): void {
    if (opened === connection) connection = undefined
    const waiting = [...opened.waiting.values()]
    opened.waiting.clear()
    opened.probing.clear()
    for (const done of opened.idle.splice(0)) done()
    for (const item of waiting) item.reject(error)
  }

  // The count is logged before the worker is stopped, since a worker held in a disk call may not stop at all.
  async function close(input: { deadlineMs: number }): Promise<{ left: number }> {
    const opened = connection
    if (!opened) return { left: 0 }
    if (opened.waiting.size > 0) await drained(opened, input.deadlineMs)
    const left = writesWaiting(opened)
    drop(opened, new Error('The action log writer closed before it answered'))
    if (left > 0) logger.error('Action log writes left unwritten at close', { left })
    if (!(await settleWithin([opened.worker.terminate()], WORKER_STOP_MS))) logger.error('The action log writer is held in a disk call; the process exits once the call returns')
    return { left }
  }

  function drained(opened: Connection, deadlineMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, deadlineMs)
      opened.idle.push(() => { clearTimeout(timer); resolve() })
    })
  }

  async function append(input: { file: LogFile; entries: ActionLogEntry[] }): Promise<void> {
    if (connection && writesWaiting(connection) >= MAX_WAITING_WRITES) throw new StateBusyError('Too many action log writes wait on the disk; retry shortly')
    const ids = input.entries.flatMap(entry => (entry.entryId === undefined ? [] : [entry.entryId]))
    const since = places.earliest(input.file, ids)
    let placedAt: number | undefined
    try {
      await request({ op: 'append', ...input, ...(since === undefined ? {} : { since }) }, { placed: (offset) => { placedAt = offset } })
    } catch (error) {
      if (placedAt !== undefined) places.remember(input.file, ids, placedAt)
      throw error
    }
    places.forget(input.file, ids)
  }

  async function probe(file: LogFile): Promise<void> {
    if (connection && [...connection.probing.values()].includes(file.path)) throw new Error('The action log writer has not answered the last probe of this log')
    await request({ op: 'probe', file }, { deadlineMs: PROBE_DEADLINE_MS })
  }

  // Most opens find no attempt another process left, and start no worker for one.
  async function recover(input: { file: LogFile; naming?: WorkspaceNaming }): Promise<number> {
    if (!createPendingAudit({ filePath: input.file.path, processInstanceId: PROCESS_INSTANCE_ID }).leftBehind()) return 0
    return (await request({ op: 'recover', ...input })) ?? 0
  }

  return { append, probe, recover, close }
}

function writesWaiting(opened: Connection): number {
  let writes = 0
  for (const waiting of opened.waiting.values()) if (waiting.op !== 'probe') writes += 1
  return writes
}

/**
 * Where the entries of failed writes may already sit, by file and entry id: a write that failed after it began may have
 * left some of its lines, so a retry to the same file reads back from the earliest place first.
 */
function createPlaces() {
  const places = new Map<string, number>()
  const key = (file: LogFile, id: string) => `${file.path}\0${id}`
  return {
    earliest(file: LogFile, ids: readonly string[]): number | undefined {
      let earliest: number | undefined
      for (const id of ids) {
        const at = places.get(key(file, id))
        if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at
      }
      return earliest
    },
    remember(file: LogFile, ids: readonly string[], offset: number): void {
      for (const id of ids) {
        const at = Math.min(places.get(key(file, id)) ?? offset, offset)
        places.delete(key(file, id))
        places.set(key(file, id), at)
      }
      for (const kept of places.keys()) {
        if (places.size <= PLACES_KEPT) break
        places.delete(kept)
      }
    },
    forget(file: LogFile, ids: readonly string[]): void {
      for (const id of ids) places.delete(key(file, id))
    },
  }
}

/** Built, the worker is the JavaScript beside this module; run from TypeScript source (tests, `pnpm buckle`), its source. */
function defaultEntry(): WriterEntry {
  return { url: new URL(import.meta.url.endsWith('.ts') ? './writer-worker.ts' : './writer-worker.js', import.meta.url) }
}

/** A TypeScript worker loads through tsx, which a worker thread does not take from a test runner's own loader. */
function loaderFor(url: URL): { execArgv?: string[] } {
  return url.pathname.endsWith('.ts') ? { execArgv: ['--import', import.meta.resolve('tsx')] } : {}
}

/** A line the worker logged, written by this thread's logger, which redacts it and holds it under the one budget. */
function relayLog(line: ForwardedLine): void {
  logger[line.level](line.message, { ...line.fields, ...(line.error ? { error: rebuiltError(line.error) } : {}) })
}

function failureError(failure: WriterFailure): Error {
  return failure.busy ? new StateBusyError(failure.message) : rebuiltError(failure)
}

/** An error from the worker as this thread's logger reads one: its name, message, stack, and code. */
function rebuiltError(source: { name: string; message: string; stack?: string; code?: string | number }): Error {
  const error = Object.assign(new Error(source.message), source.code === undefined ? {} : { code: source.code })
  error.name = source.name
  if (source.stack !== undefined) error.stack = source.stack
  return error
}
