import type { CliRequest, CliWait, PendingInteraction, UnavailableReason } from '@5straps/runtime'
import { APPROVAL_NO_DEADLINE, type ApprovalRequest } from '@5straps/protocol'
import { APPROVAL_PENDING } from '../../domain/action-phrase.js'
import { approveCommand, judgeLine, judgeNoteFor, reviewCommand } from '../../domain/approval-instruction.js'
import { MAX_TIMER_MS, remainingMs } from '../../domain/approval/expiry.js'
import type { FullAction, RatingNote } from '../../types/ports/approval-backend.js'
import { logger } from '../../runtime/log.js'
import { askViewDetails, readAskHeadline, type AskHeadline, type AskView } from './ask-view.js'

export const APPROVAL_REQUEST_KIND = 'approval'

/**
 * What a terminal answer may choose. Its token is always the one its question asked about. `session_below` and
 * `always_below` grant the ask's wider subject (a delete's folder and its subfolders) in place of its own.
 */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'session_below' | 'always_below' | 'deny' | 'deny_session' | 'deny_always'

export interface QuestionContext {
  correlationId: string
  actor?: string
  sessionId: string
  /** The whole call the asks came from, shown with each question (owner decision D17), and what the decision AI said of it. */
  call?: QuestionCall
}

export type QuestionCall = FullAction & { judge?: readonly RatingNote[] }

export interface QuestionInput { approval: ApprovalRequest; workspaceId: string; workspaceName?: string; node?: string; context: QuestionContext; approves?: boolean }

/**
 * The question the terminal shows: what the call wants, the whole call it came from (owner decision D17)
 * and the command that answers it elsewhere.
 */
export function questionFor(input: QuestionInput): CliRequest {
  const { approval, workspaceId, context } = input
  return {
    id: `approval:${workspaceId}:${approval.token}`,
    kind: APPROVAL_REQUEST_KIND,
    correlationId: context.correlationId,
    ...(context.actor === undefined ? {} : { actor: context.actor }),
    sessionId: context.sessionId,
    target: workspaceId,
    action: { summary: `${approval.tool} needs approval`, details: askViewDetails(askViewOf(input)) },
    wait: questionWait(approval.expiresAt),
  }
}

/**
 * What the durable owner queue says about a question nobody could take: the ask was issued before it
 * was asked, so it is already waiting, answerable with the command it carries. Never an approval.
 */
export async function approvalPending(request: CliRequest): Promise<PendingInteraction | undefined> {
  const { approve } = readAskHeadline(request.action.details ?? {})
  if (request.kind !== APPROVAL_REQUEST_KIND || approve === undefined) return undefined
  return { id: request.id, instructions: approve }
}

/**
 * approvalPending for a node (`buckle serve`, `buckle mcp`), which also logs one line where nobody can be asked now: no
 * terminal is attached, or no listener. The line names the tool, the rule, the offered scopes,
 * the workspace, and the command that shows the whole action; never the subject, the description, or a token, which no
 * log line carries (`Approval granted` keeps the same rule). A question dropped as the process stops, or by Ctrl-C, was
 * already on a person's screen or is no news, so it logs none.
 */
export async function nodeApprovalPending(request: CliRequest, reason: UnavailableReason): Promise<PendingInteraction | undefined> {
  const pending = await approvalPending(request)
  if (pending && (reason === 'no_consumer' || reason === 'no_listener')) logger.info(APPROVAL_PENDING, pendingFields(readAskHeadline(request.action.details ?? {})))
  return pending
}

function askViewOf(input: QuestionInput): AskView {
  const { approval, workspaceId, workspaceName } = input
  const { call } = input.context
  const named = workspaceName === undefined ? {} : { workspaceName }
  const judge = judgeDetail({ approval, call, workspaceId, ...named, ...(input.approves === undefined ? {} : { approves: input.approves }) })
  return {
    tool: approval.tool, rule: approval.rule, subject: approval.subject, reason: approval.reason,
    ...(approval.severity === undefined ? {} : { severity: approval.severity }),
    offeredScopes: approval.offeredScopes, expiresAt: approval.expiresAt, workspaceId,
    ...(approval.widerSubject === undefined ? {} : { widerSubject: approval.widerSubject }),
    ...named,
    approve: approveCommand({ request: approval, workspaceId, ...named }),
    ...(input.node === undefined ? {} : { node: input.node }),
    ...(judge === undefined ? {} : { judge }),
    ...(call === undefined ? {} : { call: { arguments: call.arguments, cwd: call.cwd, description: call.description, ...(call.effects === undefined ? {} : { effects: call.effects }) } }),
  }
}

/** The decision AI's line for one question (D91), where the call it came from carries a note about its command. */
function judgeDetail(input: { approval: ApprovalRequest; call: QuestionCall | undefined; workspaceId: string; workspaceName?: string; approves?: boolean }): string | undefined {
  const note = judgeNoteFor(input.call?.judge, input.approval)
  return note === undefined ? undefined : judgeLine(note, { token: input.approval.token, workspaceId: input.workspaceId, ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }), ...(input.approves === undefined ? {} : { approves: input.approves }) })
}

/** A question lasts as long as its request: a terminal someone sits at, not the call's grace period. */
function questionWait(expiresAt: string): CliWait {
  if (expiresAt === APPROVAL_NO_DEADLINE) return { mode: 'indefinite' }
  return { mode: 'finite', timeoutMs: Math.min(Math.max(remainingMs(expiresAt), 1), MAX_TIMER_MS) }
}

function pendingFields(headline: AskHeadline): Record<string, unknown> {
  const { workspaceId, workspaceName } = headline
  return {
    tool: headline.tool,
    rule: headline.rule,
    scopes: headline.offeredScopes,
    workspace: workspaceName ?? workspaceId,
    review: reviewCommand({ ...(workspaceId === undefined ? {} : { workspaceId }), ...(workspaceName === undefined ? {} : { workspaceName }) }),
  }
}
