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

export type WriterRequest =
  | { id: number; op: 'append'; file: LogFile; entries: ActionLogEntry[] }
  | { id: number; op: 'probe'; file: LogFile }
  | { id: number; op: 'recover'; file: LogFile; naming?: WorkspaceNaming }

/** What a failed operation left, rebuilt on the main thread; `busy` is another process holding the pending store past its wait. */
export interface WriterFailure {
  name: string
  message: string
  stack?: string
  code?: string
  busy: boolean
}

export type WriterReply =
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
