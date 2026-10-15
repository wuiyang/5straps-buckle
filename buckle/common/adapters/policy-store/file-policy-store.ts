import { z } from 'zod'
import { WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore } from '../json-file-store.js'

const fileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), WorkspacePolicySchema),
})

/**
 * The policies `buckle policy` stored before the workspace model, in policy.json keyed by folder: migration input
 * only, as each workspace's policy now lives in its workspace.json. Empty where no file is. Throws StateFileError where
 * the file cannot be read.
 */
export function readStoredPolicies(filePath: string): Record<string, WorkspacePolicy> {
  return createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} } }).read().workspaces
}
