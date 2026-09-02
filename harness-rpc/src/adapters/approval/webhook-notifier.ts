import type { ApprovalRequest } from '@5straps/protocol'
import { logger } from '../../logger.js'

const NOTIFY_TIMEOUT_MS = 5_000

/**
 * Posts pending approvals to an operator-supplied URL so a person can be reached wherever they
 * are: a Telegram bot, a chat relay, a phone notification. Buckle deliberately knows nothing
 * about the destination. Whatever receives this decides how to present it, then approves by
 * posting back to /v1/approvals or running `buckle approve`.
 *
 * The URL is operator configuration rather than model input, so it is not held to the egress
 * rules that judge a tool's own network access; a relay on the local network is a normal setup.
 */
export function createWebhookNotifier(url: string) {
  return async (requests: ApprovalRequest[]): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: requests.map(describe) }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    if (!response.ok) logger.warn('Approval webhook refused the notification', { status: response.status })
  }
}

function describe(request: ApprovalRequest) {
  return {
    token: request.token,
    tool: request.tool,
    rule: request.rule,
    subject: request.subject,
    reason: request.reason,
    expiresAt: request.expiresAt,
    offeredScopes: request.offeredScopes,
    approveCommand: `buckle approve ${request.token} --scope ${preferredScope(request)}`,
  }
}

function preferredScope(request: ApprovalRequest): string {
  return request.offeredScopes.includes('session') ? 'session' : request.offeredScopes[0] ?? 'once'
}
