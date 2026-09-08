import { z } from 'zod'

export const AgentRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
export const AgentRunSchema = z.object({
  id: z.string(), chatId: z.string(), input: z.string(), status: AgentRunStatusSchema,
  generation: z.number().int().nonnegative(), workerId: z.string().nullable(), leaseUntil: z.number().nullable(),
  error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>
