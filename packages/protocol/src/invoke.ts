import { z } from 'zod'
import { ApprovalRequestSchema } from './approval.js'
import { JsonObjectSchema, JsonValueSchema } from './json.js'

/**
 * How long the caller will wait for a person to answer an approval. It overrides the node's own wait
 * (BUCKLE_APPROVAL_TIMEOUT_MS), shorter or longer: `none` returns the pending asks at once, `finite`
 * holds the call that long. On a serving node (serve, mcp) it never changes who is asked: the node
 * asks its terminal and every other answer path the same, and the asks stay pending until answered
 * or expired. A one-shot CLI command, whose hold is its own terminal question, asks nobody under
 * `none`. Rings sends it because Rings owns the run's state (owner ruling, 2026-09-28).
 */
export const ApprovalWaitSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('finite'), ms: z.number().int().positive().max(2_147_483_647) }),
])
export type ApprovalWait = z.infer<typeof ApprovalWaitSchema>

export const InvokeContextSchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  actorId: z.string().min(1).max(200).optional(),
  agentId: z.string().min(1).max(200).optional(),
  sessionId: z.string().optional(),
  chatId: z.string().optional(),
  runId: z.string().optional(),
  stageId: z.string().min(1).max(200).optional(),
  invocationId: z.string().optional(),
  approvalWait: ApprovalWaitSchema.optional(),
})
export type InvokeContext = z.infer<typeof InvokeContextSchema>

export const InvokeRequestSchema = z.object({
  requestId: z.string().min(1),
  tool: z.string().min(1),
  args: JsonObjectSchema,
  timeoutMs: z.number().int().positive().optional(),
  /** Tokens from prior approval_required outcomes, replayed to clear the same gates. */
  approvalTokens: z.array(z.string()).default([]),
  context: InvokeContextSchema.optional(),
})
export type InvokeRequest = z.infer<typeof InvokeRequestSchema>

export const InvokeOkSchema = z.object({
  requestId: z.string(),
  outcome: z.literal('ok'),
  output: JsonValueSchema,
  meta: z.object({
    durationMs: z.number().nonnegative(),
    truncated: z.boolean().default(false),
  }),
})

export const InvokeErrorSchema = z.object({
  requestId: z.string(),
  outcome: z.literal('error'),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: JsonValueSchema.optional(),
  }),
})

export const InvokeApprovalRequiredSchema = z.object({
  requestId: z.string(),
  outcome: z.literal('approval_required'),
  approvals: z.array(ApprovalRequestSchema).min(1),
})

export const InvokeResponseSchema = z.discriminatedUnion('outcome', [
  InvokeOkSchema,
  InvokeErrorSchema,
  InvokeApprovalRequiredSchema,
])
export type InvokeResponse = z.infer<typeof InvokeResponseSchema>
