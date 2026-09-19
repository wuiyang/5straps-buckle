import { z } from 'zod'
import { JsonValueSchema } from './json.js'

export const GrantScopeSchema = z.enum(['once', 'session', 'always'])
export type GrantScope = z.infer<typeof GrantScopeSchema>

export const PermissionRuleIdSchema = z.enum([
  'sensitive_path',
  'destructive_command',
  'network_egress',
  'filesystem_policy',
  'read_scope',
  'write_scope',
  'process_probe',
  'command_policy',
  'tool_policy',
])
export type PermissionRuleId = z.infer<typeof PermissionRuleIdSchema>

/**
 * What a grant covers. `subject` is the concrete resource (a directory, a host, an argv
 * signature); the rule that raised the request decides how it is matched on replay.
 */
export const GrantSubjectSchema = z.object({
  rule: PermissionRuleIdSchema,
  subject: z.string().min(1),
})
export type GrantSubject = z.infer<typeof GrantSubjectSchema>

export const ApprovalRequestSchema = z.object({
  token: z.string().min(1),
  rule: PermissionRuleIdSchema,
  subject: z.string().min(1),
  reason: z.string().min(1),
  tool: z.string().min(1),
  /** Floor rules omit 'always' so a caller cannot permanently widen them. */
  offeredScopes: z.array(GrantScopeSchema).min(1),
  expiresAt: z.iso.datetime(),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

export const GrantRecordSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  rule: PermissionRuleIdSchema,
  subject: z.string().min(1),
  scope: GrantScopeSchema,
  sessionId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export type GrantRecord = z.infer<typeof GrantRecordSchema>

export const ApprovalDecisionSchema = z.object({
  token: z.string().min(1),
  approved: z.boolean(),
  scope: GrantScopeSchema.default('once'),
  note: JsonValueSchema.optional(),
})
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>
