import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { dirname } from 'pathe'
import { forwardRootLogger, type ForwardedLine } from '../../runtime/log.js'
import type { ActionLogEntry } from '../../types/ports/action-log.js'
import { setDescriptorMode } from '../file-modes.js'
import { StateBusyError, withFileTurn } from '../json-file-store.js'
import { entriesFrom, stringField } from './log-lines.js'
import { createPendingAudit } from './pending-audit.js'
import { entryLine, MAX_ENTRY_BYTES, nameEntry, withEntryId, type LogFile, type WriterFailure, type WriterReply, type WriterRequest, type WriterWorkerData } from './writer-protocol.js'

/** The disk calls a test steers; every other file call is node's own. */
export interface WriterIo {
  write(descriptor: number, bytes: Buffer): number
  fsync(descriptor: number): void
}

const NODE_IO: WriterIo = { write: (descriptor, bytes) => writeSync(descriptor, bytes), fsync: fsyncSync }

type PendingAudit = ReturnType<typeof createPendingAudit>
type Operations = { [Op in WriterRequest['op']]: (request: Extract<WriterRequest, { op: Op }>) => Promise<number | void> }

/**
 * The writer worker's program: it owns every write of the process's action logs, so a stalled disk holds this thread
 * and not the node's. Its own log lines go straight to the main thread's logger, under the process's one log budget.
 */
export function startWriterWorker(io: WriterIo = NODE_IO): void {
  const port = parentPort
  if (!port) throw new Error('The action log writer runs in a worker thread')
  const { processInstanceId, logLevel } = workerData as WriterWorkerData
  forwardRootLogger({ level: logLevel, forward: forwardTo(port) })
  const operations = createWriterOperations({ processInstanceId, io, tell: reply => port.postMessage(reply) })
  port.on('message', (request: WriterRequest) => { void answer({ port, operations, request }) })
}

// A line whose fields cannot cross to the main thread goes without them, so logging never throws.
function forwardTo(port: MessagePort): (line: ForwardedLine) => void {
  return (line) => {
    try {
      port.postMessage({ type: 'log', line } satisfies WriterReply)
    } catch {
      port.postMessage({ type: 'log', line: { level: line.level, message: line.message, fields: { '[unloggable]': 'fields' } } } satisfies WriterReply)
    }
  }
}

async function answer(input: { port: MessagePort; operations: Operations; request: WriterRequest }): Promise<void> {
  const { id, op } = input.request
  // Keyed by op, so the request is the one its operation takes.
  const run = input.operations[op] as (request: WriterRequest) => Promise<number | void>
  let reply: WriterReply
  try {
    const value = await run(input.request)
    reply = { type: 'done', id, ...(typeof value === 'number' ? { value } : {}) }
  } catch (error) {
    reply = { type: 'failed', id, failure: describeFailure(error) }
  }
  input.port.postMessage(reply)
}

function createWriterOperations(input: { processInstanceId: string; io: WriterIo; tell: (reply: WriterReply) => void }): Operations {
  // One pending store per file, so a store that will not read is logged once until it reads again.
  const stores = new Map<string, PendingAudit>()
  const pendingOf = (file: LogFile): PendingAudit => {
    const key = `${file.path}\0${file.lockDeadlineMs ?? ''}`
    let store = stores.get(key)
    if (!store) {
      store = createPendingAudit({ filePath: file.path, processInstanceId: input.processInstanceId, lockDeadlineMs: file.lockDeadlineMs })
      stores.set(key, store)
    }
    return store
  }
  const append = (request: AppendInput) => appendBatch({ ...request, io: input.io, pending: pendingOf(request.file) })
  return {
    append: async (request) => {
      // Before the lock, whose file would make the folder again.
      if (request.existingFolder && !existsSync(dirname(request.file.path))) throw new Error('The log\'s folder is gone, so its entries are not written')
      return append({ ...request, placed: offset => input.tell({ type: 'placed', id: request.id, offset }) })
    },
    probe: request => withFileTurn(lockOf(request.file), () => probe({ filePath: request.file.path, io: input.io, pending: pendingOf(request.file) })),
    recover: request => pendingOf(request.file).recover(entry => append({ file: request.file, entries: [nameEntry(entry, request.naming)] })),
  }
}

interface AppendInput { file: LogFile; entries: readonly ActionLogEntry[]; since?: number; placed?: (offset: number) => void }

/**
 * One batch, in this process's turn for the file and under its lock, so no other Buckle process writes between its tail
 * check, append, sync, and pending update. A batch tried again leaves out the entries already in the file since `since`.
 */
function appendBatch(input: AppendInput & { io: WriterIo; pending: PendingAudit }): Promise<void> {
  return withFileTurn(lockOf(input.file), async () => {
    const entries = input.entries.map(withEntryId)
    const already = await writtenSince({ filePath: input.file.path, since: input.since, entryIds: entries.map(entry => entry.entryId) })
    const lines = Buffer.from(entries.filter(entry => !already.has(entry.entryId)).map(serializeEntry).join(''))
    const offset = appendSynced({ filePath: input.file.path, io: input.io, data: (size, tail) => endingTornTail(lines, size, tail), placed: input.placed })
    const earlier = input.since ?? offset
    await input.pending.trackMany(entries.map(entry => ({ entry, offset: already.has(entry.entryId) ? earlier : offset })))
  })
}

function lockOf(file: LogFile): { filePath: string; lockDeadlineMs?: number } {
  return { filePath: file.path, ...(file.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: file.lockDeadlineMs }) }
}

/** Which of the ids whole lines from `since` on already carry: an earlier attempt wrote them before it failed. */
async function writtenSince(input: { filePath: string; since: number | undefined; entryIds: readonly string[] }): Promise<Set<string>> {
  const found = new Set<string>()
  if (input.since === undefined || !existsSync(input.filePath)) return found
  const wanted = new Set(input.entryIds)
  for await (const value of entriesFrom(input.filePath, input.since)) {
    const entryId = stringField(value, 'entryId')
    if (entryId !== undefined && wanted.has(entryId)) found.add(entryId)
    if (found.size === wanted.size) break
  }
  return found
}

/**
 * Under the lock, a last line with no newline is a dead writer's: it is ended and kept, never cut, since an earlier build
 * beside this one writes without the lock. Readers skip it.
 */
function endingTornTail(lines: Buffer, size: number, tail: number | undefined): Buffer {
  return lines.length > 0 && size > 0 && tail !== 10 ? Buffer.concat([Buffer.from('\n'), lines]) : lines
}

function serializeEntry(entry: ActionLogEntry): string {
  const line = entryLine(entry)
  if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) throw new Error('Audit entry exceeds the size limit')
  return line
}

/**
 * The one way the log is opened and written: created owner-only, read for its last byte, appended to
 * with what `data` makes of its size and last byte (nothing for a probe), then synced with its
 * directory. `placed` hears the size before any byte is written; the size is also returned.
 */
function appendSynced(input: { filePath: string; io: WriterIo; data: (size: number, tail: number | undefined) => Buffer; placed?: (offset: number) => void }): number {
  mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 })
  const descriptor = openSync(input.filePath, 'a+', 0o600)
  try {
    setDescriptorMode(descriptor, 0o600)
    const size = fstatSync(descriptor).size
    const tail = Buffer.alloc(1)
    if (size > 0) readSync(descriptor, tail, 0, 1, size - 1)
    const bytes = input.data(size, size > 0 ? tail[0] : undefined)
    if (bytes.length > 0) {
      input.placed?.(size)
      if (input.io.write(descriptor, bytes) !== bytes.length) throw new Error('Incomplete audit write')
    }
    input.io.fsync(descriptor)
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(input.filePath), 'r')
      try { input.io.fsync(directory) } finally { closeSync(directory) }
    }
    return size
  } finally { closeSync(descriptor) }
}

/**
 * Whether the log takes writes again, testing what an append needs without writing an entry: the append's own open and
 * syncs, one byte written and synced beside the log (a full disk fails here), and the pending store under its lock.
 */
async function probe(input: { filePath: string; io: WriterIo; pending: PendingAudit }): Promise<void> {
  appendSynced({ filePath: input.filePath, io: input.io, data: () => Buffer.alloc(0) })
  const sidecar = `${input.filePath}.probe`
  const byte = openSync(sidecar, 'w', 0o600)
  try {
    if (input.io.write(byte, Buffer.from('\n')) !== 1) throw new Error('Incomplete audit probe write')
    input.io.fsync(byte)
  } finally {
    closeSync(byte)
    rmSync(sidecar, { force: true })
  }
  await input.pending.probe()
}

function describeFailure(error: unknown): WriterFailure {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error), busy: false }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  return { name: error.name, message: error.message, busy: error instanceof StateBusyError, ...(error.stack ? { stack: error.stack } : {}), ...(code ? { code } : {}) }
}
