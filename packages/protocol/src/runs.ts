import { z } from 'zod'
import { JsonValueSchema } from './json.js'

export const AgentRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
export const AgentRunSchema = z.object({
  id: z.string(), chatId: z.string(), input: z.string(), status: AgentRunStatusSchema,
  generation: z.number().int().nonnegative(), workerId: z.string().nullable(), leaseUntil: z.number().nullable(),
  error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

export const RunStepKindSchema = z.enum(['approval_wait', 'child_run', 'model', 'tool'])

/**
 * One durable step of a run. `input`, `output` and `usage` stay opaque JSON so model message
 * parts and tool call IDs survive a round trip unchanged.
 */
export const RunStepSchema = z.object({
  id: z.string(), runId: z.string(), seq: z.number().int().nonnegative(), kind: RunStepKindSchema,
  status: z.string(), input: JsonValueSchema, output: JsonValueSchema.nullable(), usage: JsonValueSchema.nullable(),
  createdAt: z.string(), finishedAt: z.string().nullable(),
})
export type RunStep = z.infer<typeof RunStepSchema>
export type RunStepKind = z.infer<typeof RunStepKindSchema>

/** A committed run event. `id` is globally monotonic and is the resync cursor a client keeps. */
export const RunEventSchema = z.object({
  id: z.number().int().positive(), runId: z.string(), chatId: z.string(), type: z.string(),
  payload: JsonValueSchema, createdAt: z.string(),
})
export type RunEvent = z.infer<typeof RunEventSchema>
