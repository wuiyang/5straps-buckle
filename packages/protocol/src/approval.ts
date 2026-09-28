import { z } from 'zod'
import { JsonValueSchema } from './json.js'

// Wire-compatible marker for an approval that waits until explicitly answered or cancelled.
export const APPROVAL_NO_DEADLINE = '9999-12-31T23:59:59.999Z'

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
  denied: z.boolean().optional(),
  rule: PermissionRuleIdSchema,
  subject: z.string().min(1),
  scope: GrantScopeSchema,
  /**
   * The subject is a host pattern the owner widened a network approval to with `buckle approve
   * --host`, per `BUCKLE-D18`. Only this flag makes a subject a pattern, never its spelling.
   */
  pattern: z.literal(true).optional(),
  sessionId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export type GrantRecord = z.infer<typeof GrantRecordSchema>

/**
 * What became of an announced ask, told on the same sealed path as the announcement:
 * answered or denied (with the scope recorded), expired unanswered, cancelled because its caller
 * left while waiting, or skipped: the call returned without an answer and the ask stays pending.
 */
export const ApprovalLifecycleEventSchema = z.enum(['answered', 'denied', 'expired', 'cancelled', 'skipped'])
export type ApprovalLifecycleEvent = z.infer<typeof ApprovalLifecycleEventSchema>

/**
 * Why a call stopped waiting while its ask stays pending: the caller's wait hint said none, nobody
 * was at a terminal to ask, the wait ran out, or the node shut down.
 */
export const ApprovalSkipReasonSchema = z.enum(['caller_declined_wait', 'no_approver', 'wait_elapsed', 'shutdown'])
export type ApprovalSkipReason = z.infer<typeof ApprovalSkipReasonSchema>

export const ApprovalNoticeSchema = z.object({
  token: z.string().min(1),
  event: ApprovalLifecycleEventSchema,
  at: z.iso.datetime(),
  /** The recorded scope, on answered and denied. */
  scope: GrantScopeSchema.optional(),
  /** Why the call stopped waiting, on skipped. */
  reason: ApprovalSkipReasonSchema.optional(),
})
export type ApprovalNotice = z.infer<typeof ApprovalNoticeSchema>

/** The body of a lifecycle notice: which node and workspace, and what became of which asks. */
export const ApprovalNoticesSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  notices: z.array(ApprovalNoticeSchema).min(1),
})
export type ApprovalNotices = z.infer<typeof ApprovalNoticesSchema>

export const ApprovalDecisionSchema = z.object({
  token: z.string().min(1),
  approved: z.boolean(),
  scope: GrantScopeSchema.default('once'),
  note: JsonValueSchema.optional(),
})
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>

/**
 * Withdraws one call's asks still waiting (owner decision D6 of 2026-09-29), as an explicit cancel
 * does: named by one of its ask tokens, or by the requestId and session the call was sent with. Each
 * withdrawn ask is told `cancelled`. Withdrawing never approves anything.
 */
export const ApprovalWithdrawSchema = z.union([
  z.object({ token: z.string().min(1).max(200) }).strict(),
  z.object({ requestId: z.string().min(1), sessionId: z.string().min(1).max(200) }).strict(),
])
export type ApprovalWithdraw = z.infer<typeof ApprovalWithdrawSchema>
export interface ApprovalWithdrawResult { withdrawn: string[] }
