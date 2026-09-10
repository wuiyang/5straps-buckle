import { z } from 'zod'
import { JsonValueSchema } from './json.js'

/**
 * `waiting_approval` is a run held inside a turn until a person answers a node's prompt.
 * `waiting_child` is a run held until the subagent runs it spawned reach a resting status.
 * Both hold no lease, so no worker is running them and no later turn in the chat may overtake
 * them.
 */
export const AgentRunStatusSchema = z.enum(['queued', 'running', 'waiting_approval', 'waiting_child', 'succeeded', 'failed', 'cancelled', 'interrupted'])
export const AgentRunSchema = z.object({
  id: z.string(), chatId: z.string(), input: z.string(), status: AgentRunStatusSchema,
  generation: z.number().int().nonnegative(), workerId: z.string().nullable(), leaseUntil: z.number().nullable(),
  error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

/** `child_run` is one spawned subagent, held on the parent until that child's run rests. */
export const RunStepKindSchema = z.enum(['approval_wait', 'child_run', 'model', 'tool'])

/**
 * How a step stands, in the same words a run uses. `running` is written before a tool is
 * dispatched and `waiting` when a call is held for a person. `uncertain` is a dispatched call
 * whose result was lost and whose effect is known to have happened, so it is never repeated
 * automatically. Stored rows stay plain text, so a row written before this vocabulary existed
 * still reads back.
 */
export const RunStepStatusSchema = z.enum(['failed', 'running', 'succeeded', 'uncertain', 'waiting'])
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>

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
