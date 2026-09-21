import { z } from 'zod'
import { PermissionRuleIdSchema } from './approval.js'
import { JsonValueSchema } from './json.js'
import { ToolNameSchema } from './tool.js'

/**
 * What the owner of a workspace lets an agent do there. Buckle enforces it. Rings may hold a
 * copy and push it under a setup credential no agent can reach.
 *
 * Every list is a set of patterns. Command entries are shell-word globs matched against the
 * parsed command line one word at a time (`docker compose {up,down,restart} *`), with the deny
 * list also matched against each statement of a shell script body. Network entries are hosts
 * (`example.com`, `*.example.com`, `localhost:3000`) or http(s) URL prefixes
 * (`https://app.example.com/admin`).
 */
export const PatternListSchema = z.array(z.string().min(1).max(500)).max(200)

export const CommandPolicySchema = z.object({
  /** When non-empty, only a command line matching one of these may run. */
  allow: PatternListSchema.default([]),
  /** A matching command line is refused outright. Deny wins over allow. */
  deny: PatternListSchema.default([]),
  /**
   * Commands that ask before they run, on top of the node's built-in destructive floor. The
   * floor cannot be lowered, and neither these nor the built-ins ever offer a standing grant.
   * Absent in a document written before the list existed, which reads as empty.
   */
  destructive: PatternListSchema.optional(),
})

export const NetworkPolicySchema = z.object({
  /** When non-empty, only a URL matching one of these may be fetched or opened. A match also clears a private address. */
  allow: PatternListSchema.default([]),
})

export const MountPathSchema = z.string().regex(/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'An absolute path with plain segments, e.g. /workspace')

export const FilesystemPermissionSchema = z.enum(['allow', 'ask', 'deny'])
export const FilesystemRuleSchema = z.object({
  path: z.string().min(1).max(4096).refine(path => path === '.' || !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'A workspace-relative path without traversal'),
  read: FilesystemPermissionSchema.optional(),
  write: FilesystemPermissionSchema.optional(),
}).strict()
export const FilesystemPolicySchema = z.object({ rules: z.array(FilesystemRuleSchema).max(1000) }).strict()
export type FilesystemPermission = z.infer<typeof FilesystemPermissionSchema>

export const WorkspaceToolPolicySchema = z.object({
  /** Omitted inherits all tools; an empty list explicitly disables every tool. */
  allow: z.array(ToolNameSchema).max(1000).optional(),
  deny: z.array(ToolNameSchema).max(1000).default([]),
}).strict()

export const WorkspacePolicySchema = z.object({
  version: z.literal(1),
  filesystem: FilesystemPolicySchema.optional(),
  tools: WorkspaceToolPolicySchema.optional(),
  commands: CommandPolicySchema.default({ allow: [], deny: [] }),
  network: NetworkPolicySchema.default({ allow: [] }),
  /** Where the agent sees the workspace, e.g. `/workspace`. Null shows the real path. */
  mount: MountPathSchema.nullable().default(null),
  updatedAt: z.iso.datetime().nullable().default(null),
})
export const WorkspacePolicyUpdateSchema = WorkspacePolicySchema.extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() })
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>

export function isWorkspaceToolAllowed(policy: Pick<WorkspacePolicy, 'tools'>, tool: string): boolean {
  return !policy.tools?.deny.includes(tool) && (policy.tools?.allow === undefined || policy.tools.allow.includes(tool))
}

export function emptyWorkspacePolicy(): WorkspacePolicy {
  return { version: 1, commands: { allow: [], deny: [], destructive: [] }, network: { allow: [] }, mount: null, updatedAt: null }
}

/** The owner's destructive additions, absent in a policy document written before they existed. */
export function destructivePatterns(policy: WorkspacePolicy): string[] {
  return policy.commands.destructive ?? []
}

/** Fields every Buckle report carries, whether it is a lone refusal or one action-log entry. */
const BuckleReportBaseSchema = z.object({
  serverId: z.string().min(1),
  workspace: z.string().min(1),
  at: z.iso.datetime(),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  effects: z.array(z.string()),
  args: JsonValueSchema,
})

/** One refused tool call, sent to Rings as it happens so the owner sees what an agent tried. */
export const DeniedRunReportSchema = BuckleReportBaseSchema.extend({
  event: z.literal('denied_run'),
  rule: PermissionRuleIdSchema,
  subject: z.string(),
  reason: z.string(),
})
export type DeniedRunReport = z.infer<typeof DeniedRunReportSchema>

/** Every outcome an action-log entry can carry, as Buckle records it. */
export const ActionOutcomeSchema = z.enum(['interrupted', 'started', 'ok', 'error', 'denied', 'approval_required'])
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>

/**
 * One action-log entry, whatever its outcome, per `BUCKLE-D06: Buckle reports the full action
 * log`. It widens the denial report rather than replacing it: `rule`, `subject` and `reason`
 * are filled only when something refused the call. The node is named by the batch around it,
 * so an entry never disagrees with the batch it arrived in.
 */
export const ActionReportSchema = BuckleReportBaseSchema.omit({ serverId: true }).extend({
  workspaceId: z.string().min(1).default('default'),
  outcome: ActionOutcomeSchema,
  durationMs: z.number().int().min(0).default(0),
  rule: PermissionRuleIdSchema.nullable().default(null),
  subject: z.string().default(''),
  reason: z.string().default(''),
  /** Gates that stopped the call, and grants that let it through, both as `rule` names. */
  asked: z.array(z.string()).default([]),
  approvedBy: z.array(z.string()).default([]),
  detail: z.string().nullable().default(null),
})
export type ActionReport = z.infer<typeof ActionReportSchema>

/** Entries one post may carry. A busy workspace posts batches rather than one call at a time. */
export const ACTION_REPORT_BATCH_MAX = 100

export const ActionReportBatchSchema = z.object({
  event: z.literal('action_log'),
  serverId: z.string().min(1),
  reports: z.array(ActionReportSchema).min(1).max(ACTION_REPORT_BATCH_MAX),
})
export type ActionReportBatch = z.infer<typeof ActionReportBatchSchema>

/**
 * What the report endpoint accepts. A Buckle built before the action log posted lone denials,
 * and still may, so both shapes stay valid on the one route.
 */
export const BuckleReportPayloadSchema = z.discriminatedUnion('event', [DeniedRunReportSchema, ActionReportBatchSchema])
export type BuckleReportPayload = z.infer<typeof BuckleReportPayloadSchema>
