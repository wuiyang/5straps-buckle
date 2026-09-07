import type { WorkspacePolicy } from '@5straps/protocol'

/** The policy the owner stored for this workspace, by `buckle policy` locally or pushed from Rings. */
export interface PolicyStore {
  read(): WorkspacePolicy | null
  write(policy: WorkspacePolicy): void
  clear(): void
}
