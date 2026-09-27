import type { ApprovalNotice, ApprovalRequest } from '@5straps/protocol'
import { SEALED_REPORT_PATHS, type ApprovalKey } from '@5straps/protocol/envelope'
import { sealForRings } from '../../services/approvals/approval-envelope.js'
import { approveCommand } from '../../domain/approval-instruction.js'
import { logger } from '../../runtime/log.js'

const NOTIFY_TIMEOUT_MS = 5_000

export interface WebhookNotifierOptions {
  url: string
  /** Named in the payload so a relay serving several nodes can answer the right one. */
  serverId: string
  /** Which of the node's workspaces is waiting: a token resolves in its own workspace alone. */
  workspaceId: string
  /** The node's outbound credential, sent as a bearer when set. Rings requires it. */
  token?: string
  /** `RINGS-D20`: with the key minted at pairing, the notification goes sealed for Rings. */
  approvalKey?: ApprovalKey
}

/**
 * Posts pending approvals to an operator-supplied URL so a person can be reached wherever they
 * are: Rings, a Telegram bot, a chat relay, a phone notification. Buckle deliberately knows
 * nothing about the destination. Whatever receives this decides how to present it, then
 * approves by posting back to /v1/approvals or running `buckle approve`.
 *
 * The URL is operator configuration rather than model input, so it is not held to the egress
 * rules that judge a tool's own network access; a relay on the local network is a normal setup.
 */
export function createWebhookNotifier(options: WebhookNotifierOptions) {
  return async (requests: ApprovalRequest[]): Promise<void> => {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(sealForRings(options.approvalKey, SEALED_REPORT_PATHS.approvals, { serverId: options.serverId, workspaceId: options.workspaceId, approvals: requests.map(request => describe(request, options.workspaceId)) })),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    if (!response.ok) logger.warn('Approval webhook refused the notification', { status: response.status })
  }
}

/**
 * Posts lifecycle notices for announced asks to the same URL, sealed for the same path. A Rings
 * that does not take them yet answers 4xx; that is said once, since nothing on the node depends on it.
 */
export function createApprovalNoticeSender(options: WebhookNotifierOptions) {
  let refusalLogged = false
  return async (notices: ApprovalNotice[]): Promise<void> => {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(sealForRings(options.approvalKey, SEALED_REPORT_PATHS.approvals, { serverId: options.serverId, workspaceId: options.workspaceId, notices })),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    if (response.ok) return
    if (refusalLogged) logger.debug('Approval webhook refused a lifecycle notice', { status: response.status })
    else logger.warn('Approval webhook refused a lifecycle notice; further refusals are logged at debug', { status: response.status })
    refusalLogged = true
  }
}

function describe(request: ApprovalRequest, workspaceId: string) {
  return {
    token: request.token,
    tool: request.tool,
    rule: request.rule,
    subject: request.subject,
    reason: request.reason,
    expiresAt: request.expiresAt,
    offeredScopes: request.offeredScopes,
    workspaceId,
    approveCommand: approveCommand({ request, workspaceId }),
  }
}
