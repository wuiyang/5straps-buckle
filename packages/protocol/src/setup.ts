import { z } from 'zod'
import { MountPathSchema } from './policy.js'

/**
 * Where a row of a workspace's mount table comes from: the folder's own entry, one of the workspace's own mounts, one
 * of the node's read-only default mounts (BUCKLE_MOUNTS), or one of the node's scratch roots (BUCKLE_SCRATCH_ROOTS).
 */
export const MountOriginSchema = z.enum(['folder', 'workspace', 'node default', 'node scratch root'])

/**
 * One row of a workspace's mount table, as `buckle workspace mount list --json` prints it: the host folder or file, the
 * sandbox path the agent sees it at, and whether it is shared read-write or read-only. The folders every sandbox binds
 * for the host's own programs, and the node's toolchains, are never a row.
 */
export const MountRowSchema = z.object({
  source: z.string(),
  target: z.string(),
  access: z.enum(['rw', 'ro']),
  from: MountOriginSchema,
})

/**
 * The `workspace` object of the setup face's `GET /setup/status`: the workspace's folder, where the agent sees it (null
 * for its real path), and that path as the agent names it. `mounts`, the mount table, came later and is optional, so a
 * reader written before it ignores it, and a node that sends none still validates.
 */
export const SetupWorkspaceStatusSchema = z.object({
  root: z.string(),
  mount: MountPathSchema.nullable(),
  displayRoot: z.string(),
  mounts: z.array(MountRowSchema).optional(),
})

export type MountOrigin = z.infer<typeof MountOriginSchema>
export type MountRow = z.infer<typeof MountRowSchema>
export type SetupWorkspaceStatus = z.infer<typeof SetupWorkspaceStatusSchema>
