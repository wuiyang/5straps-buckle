import type { ApprovalNotice, ApprovalRequest } from '@5straps/protocol'
import { SEALED_REPORT_PATHS, type ApprovalKey } from '@5straps/protocol/envelope'
import { sealForRings } from '../../services/approvals/approval-envelope.js'
import { shownCall, type AskedCall } from '../../services/approvals/approval-registry.js'
import { approveCommand, reviewCommand, workspaceLabel } from '../../domain/approval-instruction.js'
import { logger } from '../../runtime/log.js'

const NOTIFY_TIMEOUT_MS = 5_000

export interface WebhookNotifierOptions {
  url: string
  /** Named in the payload so a relay serving several nodes can answer the right one. */
  serverId: string
  /** Which of the node's workspaces is waiting: a token resolves in its own workspace alone. */
  workspaceId: string
  /**
   * The workspace's name, read at each post, so a rename shows: an ask names `workspace <id> (<name>)` on every route
   * (the workspace-model brief, item 6; finding 30 of the Phase 1 review).
   */
  readonly workspaceName?: string
  /** The node's outbound credential, sent as a bearer when set. Rings requires it. */
  token?: string
  /** `RINGS-D20`: with the key minted at pairing, the notification goes sealed for Rings. */
  approvalKey?: ApprovalKey
}

/**
 * Posts pending approvals to an operator-supplied URL so a person can be reached wherever they
 * are: Rings, a Telegram bot, a chat relay, a phone notification. Buckle deliberately knows
 * nothing about the destination. Whatever receives this decides how to present it. Only a person
 * approves: with `buckle approve` at the node's terminal, or with an enrolled device's signed decision
 * over the node's challenge (`buckle client approve`, posted to `/setup/approvals`, which the node serves
 * only under BUCKLE_EXPERIMENTAL_ADMIN_HTTP). A relay's token or a Rings-sealed body can only deny there.
 *
 * The URL is operator configuration rather than model input, so it is not held to the egress
 * rules that judge a tool's own network access; a relay on the local network is a normal setup.
 */
export function createWebhookNotifier(options: WebhookNotifierOptions) {
  return async (requests: ApprovalRequest[], recorded?: AskedCall): Promise<void> => {
    // Owner default D19: only the paired Rings key receives the whole call.
    const call = options.approvalKey ? shownCall(recorded) : undefined
    const response = await postSealed(options, { approvals: requests.map(request => describe(request, options)), ...(recorded?.description === null || recorded?.description === undefined ? {} : { description: recorded.description }), ...(call ? { call } : {}) })
    if (!response.ok) logger.warn('Approval webhook refused the notification', { status: response.status })
  }
}

/**
 * Posts lifecycle notices for announced asks to the same URL, sealed for the same path. A Rings
 * that refuses them leaves the durable notice pending for another attempt.
 */
export function createApprovalNoticeSender(options: WebhookNotifierOptions) {
  let refusalLogged = false
  return async (notices: ApprovalNotice[]): Promise<void> => {
    const response = await postSealed(options, { notices })
    if (response.ok) return
    if (refusalLogged) logger.debug('Approval webhook refused a lifecycle notice', { status: response.status })
    else logger.warn('Approval webhook refused a lifecycle notice; further refusals are logged at debug', { status: response.status })
    refusalLogged = true
    throw new Error(`Approval lifecycle webhook returned HTTP ${response.status}`)
  }
}

/** One body to the approval webhook, naming the node and workspace, sealed for Rings when a key was paired. */
function postSealed(options: WebhookNotifierOptions, body: { approvals: unknown[]; call?: unknown } | { notices: ApprovalNotice[] }): Promise<Response> {
  return fetch(options.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(sealForRings(options.approvalKey, SEALED_REPORT_PATHS.approvals, { serverId: options.serverId, workspaceId: options.workspaceId, ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}), ...body })),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  })
}

/**
 * One ask as a relay is told of it. `reviewCommand` comes before `approveCommand`: a person reads the whole
 * action with `buckle approvals` first, and `buckle approve` shows it again before it decides (owner decision D17).
 */
function describe(request: ApprovalRequest, options: Pick<WebhookNotifierOptions, 'workspaceId' | 'workspaceName'>) {
  const { workspaceId, workspaceName } = options
  return {
    token: request.token,
    tool: request.tool,
    rule: request.rule,
    subject: request.subject,
    reason: request.reason,
    expiresAt: request.expiresAt,
    offeredScopes: request.offeredScopes,
    workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    workspace: workspaceLabel(workspaceId, workspaceName),
    reviewCommand: reviewCommand({ workspaceId, ...(workspaceName ? { workspaceName } : {}) }),
    approveCommand: approveCommand({ request, workspaceId, ...(workspaceName ? { workspaceName } : {}) }),
  }
}
