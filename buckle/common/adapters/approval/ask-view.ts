import { ApprovalSeveritySchema, GrantScopeSchema, JsonValueSchema, PermissionRuleIdSchema, type ApprovalSeverity, type GrantScope, type JsonValue, type PermissionRuleId } from '@5straps/protocol'
import { z } from 'zod'

/** A question's details as the CLI requester carries them: flat values, since the serve terminal may sit in another process. */
export type QuestionDetails = Readonly<Record<string, string | number | boolean>>

/** The whole call an ask recorded, as a question carries it (owner decision D17). */
export interface AskViewCall {
  arguments: JsonValue
  cwd: string
  description: string | null
  effects?: string[]
}

/**
 * One waiting ask as a terminal question shows it: the request, where it waits, the command that answers it elsewhere,
 * the decision AI's line, and the whole call where it was recorded whole. Without `call` it offers denials alone.
 */
export interface AskView {
  tool: string
  rule: PermissionRuleId
  subject: string
  widerSubject?: string
  reason: string
  severity?: ApprovalSeverity
  offeredScopes: GrantScope[]
  expiresAt: string
  workspaceId?: string
  workspaceName?: string
  node?: string
  /** The command that answers it from another terminal, which the owner queue hands out where no terminal is attached. */
  approve?: string
  judge?: string
  call?: AskViewCall
}

/** What the pending log line reads of a question, each field on its own, so a question missing some still logs the rest. */
export interface AskHeadline {
  tool?: string
  rule?: string
  offeredScopes?: string[]
  workspaceId?: string
  workspaceName?: string
  approve?: string
}

const jsonText = <T extends z.ZodType>(schema: T) => z.string().transform((value, context) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' })
    return z.NEVER
  }
}).pipe(schema)

const DetailsSchema = z.object({
  severity: ApprovalSeveritySchema.optional(),
  tool: z.string(), rule: PermissionRuleIdSchema, subject: z.string(), wider: z.string().optional(), reason: z.string(),
  scopes: z.string().transform(value => value.split(',')).pipe(z.array(GrantScopeSchema).min(1)),
  expiresAt: z.string(), workspace: z.string().optional(), workspaceName: z.string().optional(), node: z.string().optional(),
  approve: z.string().optional(),
  arguments: jsonText(JsonValueSchema).optional(), cwd: z.string().optional(), description: z.string().optional(), effects: jsonText(z.array(z.string())).optional(),
  judge: z.string().optional(),
})

export function askViewDetails(view: AskView): Record<string, string> {
  const { call } = view
  return {
    tool: view.tool, rule: view.rule, subject: view.subject, reason: view.reason,
    ...(view.severity === undefined ? {} : { severity: view.severity }),
    scopes: view.offeredScopes.join(','), expiresAt: view.expiresAt,
    ...(view.workspaceId === undefined ? {} : { workspace: view.workspaceId }),
    ...(view.widerSubject === undefined ? {} : { wider: view.widerSubject }),
    ...(view.workspaceName === undefined ? {} : { workspaceName: view.workspaceName }),
    ...(view.approve === undefined ? {} : { approve: view.approve }),
    ...(view.node === undefined ? {} : { node: view.node }),
    ...(view.judge === undefined ? {} : { judge: view.judge }),
    ...(call === undefined ? {} : { arguments: JSON.stringify(call.arguments), cwd: call.cwd, ...(call.description === null ? {} : { description: call.description }), ...(call.effects === undefined ? {} : { effects: JSON.stringify(call.effects) }) }),
  }
}

/** The view a question carries; throws where its details are not an ask's. */
export function readAskView(details: QuestionDetails | undefined): AskView {
  const parsed = DetailsSchema.parse(details)
  const call = parsed.arguments === undefined || parsed.cwd === undefined ? undefined : { arguments: parsed.arguments, cwd: parsed.cwd, description: parsed.description ?? null, ...(parsed.effects === undefined ? {} : { effects: parsed.effects }) }
  return {
    tool: parsed.tool, rule: parsed.rule, subject: parsed.subject, ...(parsed.wider === undefined ? {} : { widerSubject: parsed.wider }), reason: parsed.reason, offeredScopes: parsed.scopes, expiresAt: parsed.expiresAt,
    ...(parsed.workspace ? { workspaceId: parsed.workspace } : {}), ...(parsed.workspaceName ? { workspaceName: parsed.workspaceName } : {}), ...(parsed.node ? { node: parsed.node } : {}), ...(call ? { call } : {}),
    ...(parsed.severity === undefined ? {} : { severity: parsed.severity }),
    ...(parsed.judge === undefined ? {} : { judge: parsed.judge }),
    ...(parsed.approve === undefined ? {} : { approve: parsed.approve }),
  }
}

export function readAskHeadline(details: QuestionDetails): AskHeadline {
  const text = (key: string) => (typeof details[key] === 'string' ? details[key] : undefined)
  const scopes = text('scopes')
  return {
    tool: text('tool'), rule: text('rule'), offeredScopes: scopes?.split(','),
    workspaceId: text('workspace'), workspaceName: text('workspaceName'), approve: text('approve'),
  }
}
