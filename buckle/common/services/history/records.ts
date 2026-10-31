import { z } from 'zod'
import { snapshotSchema } from './snapshot.js'
import { treeCaptureSchema } from './git-store.js'

export const checkpointSchema = z.object({
  id: z.string(), sessionId: z.string(), stageId: z.string(), tool: z.string(), requestId: z.string().optional(), parentRequestId: z.string().optional(), baselineAvailable: z.boolean().default(true), createdAt: z.string(),
  status: z.enum(['pending', 'complete', 'interrupted']), reason: z.string().optional(), roots: z.array(z.string()), excluded: z.array(z.string()).optional(),
  before: snapshotSchema, after: snapshotSchema.optional(), beforeTrees: z.array(treeCaptureSchema).optional(), afterTrees: z.array(treeCaptureSchema).optional(),
  restores: z.string().optional(), undoes: z.number().int().min(1).optional(), turnId: z.string().optional(), turnStageId: z.string().nullable().optional(),
  restorable: z.boolean().optional(), legacy: z.boolean().optional(), changed: z.array(z.string()).optional(),
  /**
   * `blobs`: a checkpoint of the paths its call names (Slice F2, item 1), its file content in the history's object store
   * (object-store.ts) and `scope` the paths it records; absent, the shadow-git checkpoint `beforeTrees` and `afterTrees` hold.
   */
  content: z.literal('blobs').optional(), scope: z.array(z.object({ path: z.string(), tree: z.boolean().optional() })).optional(),
})
export type Checkpoint = z.infer<typeof checkpointSchema>
