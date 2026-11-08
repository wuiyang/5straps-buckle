import { randomUUID } from 'node:crypto'
import type { LogEvent } from '@5straps/runtime'
import type { ActionLogEntry } from '../../types/ports/action-log.js'

/** One log file as the writer worker opens it: its path, and how long its pending store waits for another process. */
export interface LogFile {
  path: string
  lockDeadlineMs?: number
}

/** The workspace whose name the log stamps on its own entries, read at each write. */
export interface WorkspaceNaming {
  workspaceId?: string
  workspaceName: string
}

/** `since`: where an earlier, failed attempt at some of these entries began writing, so those already there are left out. */
export type WriterRequest =
  | { id: number; op: 'append'; file: LogFile; entries: ActionLogEntry[]; since?: number }
  | { id: number; op: 'probe'; file: LogFile }
  | { id: number; op: 'recover'; file: LogFile; naming?: WorkspaceNaming }

/** What a failed operation left, rebuilt on the main thread; `busy` is another process holding the log or its pending store past the wait. */
export interface WriterFailure {
  name: string
  message: string
  stack?: string
  code?: string
  busy: boolean
}

/** `placed`: where an append is about to write, sent before its bytes, so a write that never answers still says it. */
export type WriterReply =
  | { type: 'placed'; id: number; offset: number }
  | { type: 'done'; id: number; value?: number }
  | { type: 'failed'; id: number; failure: WriterFailure }
  | { type: 'log'; event: LogEvent }

/** What the worker is started with, beside what its entry adds. */
export interface WriterWorkerData {
  processInstanceId: string
}

/** The log's own workspace's entries carry its name beside the UUID; another workspace's entry, or one naming its own, is left as it is. */
export function nameEntry(entry: ActionLogEntry, naming: WorkspaceNaming | undefined): ActionLogEntry {
  return naming && entry.workspaceId === naming.workspaceId && entry.workspaceName === undefined ? { ...entry, workspaceName: naming.workspaceName } : entry
}

/** The entry with the id it keeps across every attempt at writing it; one it has keeps it. */
export function withEntryId(entry: ActionLogEntry): ActionLogEntry & { entryId: string } {
  return entry.entryId === undefined ? { ...entry, entryId: randomUUID() } : { ...entry, entryId: entry.entryId }
}
