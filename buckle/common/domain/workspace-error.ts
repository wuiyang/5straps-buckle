import type { ServiceFailure } from '../types/service-failure.js'

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

/** A name another workspace holds already (D85, Q15): the owner is asked for another at a terminal, and refused without one. */
export class WorkspaceNameTakenError extends WorkspaceError {
  override readonly code = 'WORKSPACE_NAME_TAKEN'
  constructor(name: string) { super(`A workspace is already named ${name}; choose another name`, 409) }
}

/**
 * A name the registry would refuse, the folder's own or one given (D85, Q15): the owner is asked for another at a
 * terminal, and refused naming --name without one. Raised before anything is written, so a refused name leaves no records.
 */
export class WorkspaceNameRefusedError extends WorkspaceError {
  override readonly code = 'WORKSPACE_NAME_REFUSED'
  constructor(name: string, reasons: string, source: 'folder' | 'given') { super(`${source === 'folder' ? `The folder's name ${name}` : `The name ${name}`} cannot be a workspace name: ${reasons}`, 400) }
}
