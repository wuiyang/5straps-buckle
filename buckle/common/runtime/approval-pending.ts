import type { CliRequest, PendingInteraction, UnavailableReason } from '@5straps/runtime'
import { readAskHeadline, type AskHeadline } from '../adapters/approval/ask-view.js'
import { APPROVAL_REQUEST_KIND } from '../adapters/approval/terminal-question.js'
import { APPROVAL_PENDING } from '../domain/action-phrase.js'
import { reviewCommand } from '../domain/approval-instruction.js'
import { logger } from './log.js'

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
