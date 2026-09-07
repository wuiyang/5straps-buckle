import { z } from 'zod'
import { PermissionRuleIdSchema } from './approval.js'
import { JsonValueSchema } from './json.js'

/**
 * What the owner of a workspace lets an agent do there. Buckle enforces it. Rings may hold a
 * copy and push it under a setup credential no agent can reach.
 *
 * Every list is a set of patterns. Command entries are JavaScript regular expressions tested
 * against the parsed command line (`docker compose up`), with the deny list also tested against
 * each statement of a shell script body. Network entries are hosts (`example.com`,
 * `*.example.com`, `localhost:3000`) or http(s) URL prefixes (`https://app.example.com/admin`).
 */
export const PatternListSchema = z.array(z.string().min(1).max(500)).max(200)

export const CommandPolicySchema = z.object({
  /** When non-empty, only a command line matching one of these may run. */
  allow: PatternListSchema.default([]),
  /** A matching command line is refused outright. Deny wins over allow. */
  deny: PatternListSchema.default([]),
})

export const NetworkPolicySchema = z.object({
  /** When non-empty, only a URL matching one of these may be fetched or opened. A match also clears a private address. */
  allow: PatternListSchema.default([]),
})

export const MountPathSchema = z.string().regex(/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'An absolute path with plain segments, e.g. /workspace')

export const WorkspacePolicySchema = z.object({
  version: z.literal(1),
  commands: CommandPolicySchema.default({ allow: [], deny: [] }),
  network: NetworkPolicySchema.default({ allow: [] }),
  /** Where the agent sees the workspace, e.g. `/workspace`. Null shows the real path. */
  mount: MountPathSchema.nullable().default(null),
  updatedAt: z.iso.datetime().nullable().default(null),
})
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>

export function emptyWorkspacePolicy(): WorkspacePolicy {
  return { version: 1, commands: { allow: [], deny: [] }, network: { allow: [] }, mount: null, updatedAt: null }
}

/** One refused tool call, sent to Rings as it happens so the owner sees what an agent tried. */
export const DeniedRunReportSchema = z.object({
  event: z.literal('denied_run'),
  serverId: z.string().min(1),
  workspace: z.string().min(1),
  at: z.iso.datetime(),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  rule: PermissionRuleIdSchema,
  subject: z.string(),
  reason: z.string(),
  effects: z.array(z.string()),
  args: JsonValueSchema,
})
export type DeniedRunReport = z.infer<typeof DeniedRunReportSchema>
