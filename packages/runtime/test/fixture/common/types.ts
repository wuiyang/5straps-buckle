import type { OperationScope } from '@5straps/runtime'
import type { AccessService } from './access.js'
import type { Note } from './notes.js'

export interface NoteService {
  add(input: { text: string; actor: string }): Promise<Note>
  list(): Promise<Note[]>
}

// Scoped: one per operation, bound to that operation's identity.
export interface OperationService {
  readonly correlationId: string
  readonly actor: string | undefined
  record(operation: string): number
}

// Transient: a fresh instance per resolution.
export interface TransientProbe {
  readonly id: string
}

export interface FixtureServices {
  getAccess(): Promise<AccessService>
  getNotes(): Promise<NoteService>
  getOperation(scope?: OperationScope): Promise<OperationService>
  createProbe(scope?: OperationScope): Promise<TransientProbe>
}

export type RuntimeRole = 'server' | 'mcp' | 'cli'
