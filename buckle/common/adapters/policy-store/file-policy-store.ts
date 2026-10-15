import { z } from 'zod'
import { WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore } from '../json-file-store.js'

const fileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), WorkspacePolicySchema),
})

/**
 * The policy `buckle policy` stored for one workspace folder before the workspace model, in policy.json keyed by
 * folder: migration input only, as each workspace's policy now lives in its workspace.json. Null where none was
 * stored. Throws StateFileError where the file cannot be read.
 */
export function readStoredPolicy(input: { filePath: string; workspace: string }): WorkspacePolicy | null {
  return createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} } }).read().workspaces[input.workspace] ?? null
}
