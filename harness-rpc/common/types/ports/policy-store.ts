import type { WorkspacePolicy } from '@5straps/protocol'

/** The policy the owner stored for this workspace, by `buckle policy` locally or pushed from Rings. */
export interface PolicyStore {
  read(): WorkspacePolicy | null
  write(policy: WorkspacePolicy, expectedRevision?: string): Promise<void>
  /** Reads, changes and stores under the file's lock; `change` returning null drops the stored policy. */
  update(change: (current: WorkspacePolicy | null) => WorkspacePolicy | null, expectedRevision?: string): Promise<void>
}
