import type { CliRequest, CliWait } from '@5straps/runtime'
import { APPROVAL_NO_DEADLINE, type ApprovalRequest } from '@5straps/protocol'
import { approveCommand, judgeLine, judgeNoteFor } from '../../domain/approval-instruction.js'
import { MAX_TIMER_MS, remainingMs } from '../../domain/approval/expiry.js'
import { saveChoices, type Unsaved } from '../../domain/approval/grant-save-question.js'
import type { FullAction, FullAsk, RatingNote } from '../../types/ports/approval-backend.js'
import { askViewDetails, type AskView } from './ask-view.js'

export const APPROVAL_REQUEST_KIND = 'approval'
/** The question after a decision whose grant did not save: retry, skip, or leave it. */
export const GRANT_SAVE_REQUEST_KIND = 'grant_save'
/** How long a save question waits: its person answered the ask above it a moment before, and the next question waits behind it. */
export const SAVE_QUESTION_WAIT_MS = 60_000

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

/**
 * The save question for a decision on `ask` that did not save, the `attempt`-th for it, so a retry that fails again asks
 * afresh. A lasting denial's question lasts no longer than its ask, which still waits.
 */
export function saveQuestionFor(input: { ask: FullAsk; unsaved: Unsaved; attempt: number }): CliRequest {
  const { ask, unsaved } = input
  const { workspace, requester } = ask
  const until = unsaved.kind === 'denial' ? Math.min(remainingMs(ask.deadline.expiresAt), SAVE_QUESTION_WAIT_MS) : SAVE_QUESTION_WAIT_MS
  return {
    id: `${GRANT_SAVE_REQUEST_KIND}:${workspace.id}:${ask.token}:${input.attempt}`,
    kind: GRANT_SAVE_REQUEST_KIND,
    correlationId: ask.correlation.correlationId,
    ...(requester.actor === null ? {} : { actor: requester.actor }),
    sessionId: requester.sessionId,
    target: workspace.id,
    action: {
      summary: unsaved.warning,
      details: { workspace: workspace.id, ...(workspace.name === undefined ? {} : { workspaceName: workspace.name }), warning: unsaved.warning, choices: saveChoices(unsaved.kind) },
    },
    wait: { mode: 'finite', timeoutMs: Math.max(until, 1) },
  }
}
