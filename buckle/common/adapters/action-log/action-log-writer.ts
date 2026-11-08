import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { LogEvent } from '@5straps/runtime'
import { logger } from '../../runtime/log.js'
import type { ActionLogEntry } from '../../types/ports/action-log.js'
import { StateBusyError } from '../json-file-store.js'
import type { LogFile, WorkspaceNaming, WriterFailure, WriterReply, WriterRequest, WriterWorkerData } from './writer-protocol.js'

/** How long readiness waits for the worker to probe a failing log; one that does not answer in time still fails. */
export const PROBE_DEADLINE_MS = 1_000

/** Ties the attempts this process leaves pending to it, across the worker threads it starts. */
const PROCESS_INSTANCE_ID = randomUUID()

/**
 * The process's one writer of action log files, on a worker thread: the main thread hands it entries and awaits its ack,
 * so a stalled disk holds the callers waiting on their entries and not the node.
 */
export interface ActionLogWriter {
  /** Resolves once every entry is synced to disk and each attempt among them is tracked until its result. */
  append(input: { file: LogFile; entries: ActionLogEntry[] }): Promise<void>
  /** Rejects while the log cannot take a write, or when the worker does not answer within PROBE_DEADLINE_MS. */
  probe(file: LogFile): Promise<void>
  /** Writes an interrupted result for each attempt whose process stopped before its own; resolves with their count. */
  recover(input: { file: LogFile; naming?: WorkspaceNaming }): Promise<number>
  /** Waits for the writes in flight until the deadline, then stops the worker; what was left fails and is counted. A later write starts another worker. */
  close(options: { deadlineMs: number }): Promise<{ left: number }>
}

/** The worker's program. A test hands in one on a disk it steers, with the shared memory it steers it by. */
export interface WriterEntry {
  url: URL
  workerData?: Record<string, unknown>
}

interface Waiting { resolve: (value: number | undefined) => void; reject: (error: Error) => void }
interface Connection { worker: Worker; waiting: Map<number, Waiting>; idle: Array<() => void> }

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

  function connect(): Connection {
    if (connection) return connection
    const workerData: WriterWorkerData & Record<string, unknown> = { ...entry.workerData, processInstanceId: PROCESS_INSTANCE_ID }
    const worker = new Worker(entry.url, { workerData, ...loaderFor(entry.url) })
    const opened: Connection = { worker, waiting: new Map(), idle: [] }
    // Idle, the worker never keeps the process alive; a write in flight does.
    worker.unref()
    worker.on('message', (reply: WriterReply) => receive(opened, reply))
    worker.on('error', error => drop(opened, new Error('The action log writer failed', { cause: error })))
    worker.on('exit', code => drop(opened, new Error(`The action log writer stopped with code ${code} before it answered`)))
    connection = opened
    return opened
  }

  function request(operation: Operation, deadlineMs?: number): Promise<number | undefined> {
    const opened = connect()
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = deadlineMs === undefined ? undefined : setTimeout(() => settle(opened, id)?.reject(new Error('The action log writer did not answer in time')), deadlineMs)
      const clear = () => clearTimeout(timer)
      opened.waiting.set(id, { resolve: value => { clear(); resolve(value) }, reject: error => { clear(); reject(error) } })
      opened.worker.ref()
      try {
        opened.worker.postMessage({ ...operation, id } satisfies WriterRequest)
      } catch (error) {
        settle(opened, id)?.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function receive(opened: Connection, reply: WriterReply): void {
    if (reply.type === 'log') return relayLog(reply.event)
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
    for (const done of opened.idle.splice(0)) done()
    for (const item of waiting) item.reject(error)
  }

  async function close(input: { deadlineMs: number }): Promise<{ left: number }> {
    const opened = connection
    if (!opened) return { left: 0 }
    if (opened.waiting.size > 0) await drained(opened, input.deadlineMs)
    const left = opened.waiting.size
    drop(opened, new Error('The action log writer closed before it answered'))
    await opened.worker.terminate()
    if (left > 0) logger.error('Action log writes left unwritten at close', { left })
    return { left }
  }

  function drained(opened: Connection, deadlineMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, deadlineMs)
      opened.idle.push(() => { clearTimeout(timer); resolve() })
    })
  }

  return {
    append: async input => { await request({ op: 'append', ...input }) },
    probe: async file => { await request({ op: 'probe', file }, PROBE_DEADLINE_MS) },
    recover: async input => (await request({ op: 'recover', ...input })) ?? 0,
    close,
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

/** A line the worker logged, written by this thread's logger, which applies its level and holds it under the process's one budget. */
function relayLog(event: LogEvent): void {
  logger[event.level](event.message, { ...event.fields, ...(event.error ? { error: rebuiltError(event.error) } : {}) })
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
