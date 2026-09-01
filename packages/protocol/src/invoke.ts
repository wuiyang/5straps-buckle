import { z } from 'zod'
import { ApprovalRequestSchema } from './approval.js'
import { JsonObjectSchema, JsonValueSchema } from './json.js'

export const InvokeContextSchema = z.object({
  sessionId: z.string().optional(),
  chatId: z.string().optional(),
  runId: z.string().optional(),
  invocationId: z.string().optional(),
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
