import { join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, StateFileError } from '../../adapters/json-file-store.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { NODE_SCOPE } from '../../types/ports/client-keys.js'

/** The code a transport tells an unreadable registry by, before it has authenticated anyone. */
export const WORKSPACE_REGISTRY_UNREADABLE = 'WORKSPACE_REGISTRY_UNREADABLE'

export class WorkspaceError extends Error implements ServiceFailure {
  readonly code: string = 'WORKSPACE_REFUSED'
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

/** workspaces.json will not parse. Its message names the file and fields, so only the owner's routes may show it. */
export class WorkspaceRegistryError extends WorkspaceError {
  override readonly code = WORKSPACE_REGISTRY_UNREADABLE
}

/** A workspace id: a lower-case word, `node` excepted, which names the whole node in a key's scope (review items 9 and 22). */
export const WorkspaceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'A workspace id is a lower-case letter, then up to 63 lower-case letters, digits or hyphens')
  .refine(value => value !== NODE_SCOPE, 'node is reserved: it names the whole node in a key\'s scope')

export const WorkspaceNameSchema = z.string().trim().min(1).max(120)

/** One agent token, kept as its sha256 only: the token itself is shown once, when it is minted (the workspace-model brief, item 1). */
const StoredTokenSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().trim().max(120).default(''),
  createdAt: z.string(),
}).strict()
export type StoredToken = z.infer<typeof StoredTokenSchema>

const StoredWorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: WorkspaceNameSchema,
  /** The workspace's folder, as the disk names it. Fixed once registered: grants, history and settings are keyed to the workspace by it. */
  dir: z.string().min(1).max(4096),
  /** Whether `buckle serve` serves it, as an MCP server is enabled or disabled (D83 addendum (5)). */
  online: z.boolean(),
  tokens: z.array(StoredTokenSchema),
  /** Counts the record's changes. */
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /**
   * When this registration was made, which a remove and a new registration under the same id change: a runtime opened
   * for an earlier one is not this one's (finding 2 of the Phase 1 review). Absent on a record written before it was kept.
   */
  createdAt: z.string().optional(),
}).strict()
export type StoredWorkspace = z.infer<typeof StoredWorkspaceSchema>

/**
 * workspaces.json, version 2 (D83). Version 1 held clear-text tokens, an admin credential per workspace and the
 * registration policy, and left the node's own folder implicit; migration (migrateNode) turns it into this once. A
 * Buckle that reads version 1 only refuses this file, so an older binary sharing the state directory fails closed.
 */
export const RegistrySchema = z.object({ version: z.literal(2), workspaces: z.array(StoredWorkspaceSchema) }).strict()
export type Registry = z.infer<typeof RegistrySchema>

export function registryPath(stateDirectory: string): string {
  return join(stateDirectory, 'workspaces.json')
}

export interface RegistryStore {
  /** Throws WorkspaceRegistryError when the file cannot be read; an absent file is an empty registry. */
  read(): Registry
  update<R>(change: (state: Registry) => R | Promise<R>): Promise<R>
}

// A registry the node cannot read is the owner's to repair: a 409 naming the file and fields, not a 500.
export function openRegistry(input: { stateDirectory: string; lockDeadlineMs?: number }): RegistryStore {
  const store = createJsonFileStore({ filePath: registryPath(input.stateDirectory), schema: RegistrySchema, fallback: { version: 2 as const, workspaces: [] }, lockDeadlineMs: input.lockDeadlineMs })
  const repairable = (error: unknown): unknown => error instanceof StateFileError ? new WorkspaceRegistryError(error.message, 409) : error
  return {
    read() {
      try { return store.read() } catch (error) { throw repairable(error) }
    },
    update: change => store.update(change).catch((error: unknown) => { throw repairable(error) }),
  }
}

/** A record's next revision and time, so every change is counted and ordered. */
export function touched(workspace: StoredWorkspace): void {
  workspace.revision += 1
  workspace.updatedAt = new Date(Math.max(Date.now(), Date.parse(workspace.updatedAt) + 1 || 0)).toISOString()
}
