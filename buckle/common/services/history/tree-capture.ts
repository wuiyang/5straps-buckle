import { z } from 'zod'
import { snapshotSchema } from './snapshot-contract.js'

export const treeCaptureSchema = z.object({ root: z.string(), workTree: z.string(), selector: z.string(), git: z.string(), commit: z.string(), extra: snapshotSchema })
export type TreeCapture = z.infer<typeof treeCaptureSchema>
