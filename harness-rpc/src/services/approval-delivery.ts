import { createCliApprovalChannel } from '../adapters/approval/cli-approval-channel.js'
import { createDeferredApprovalChannel } from '../adapters/approval/deferred-approval-channel.js'
import { createWaitingApprovalChannel } from '../adapters/approval/waiting-approval-channel.js'
import { createWebhookNotifier } from '../adapters/approval/webhook-notifier.js'
import type { BuckleConfig } from '../config.js'
import type { ApprovalChannel } from '../ports/approval-channel.js'
import type { ApprovalRegistry } from './approval-registry.js'

export interface ApprovalDeliveryOptions {
  config: BuckleConfig
  approvals: ApprovalRegistry
  /** Named in every notification, because a token is only answerable in its own workspace. */
  workspaceId: string
}

/**
 * How a gated call reaches a person: held open for the grace period while an answer arrives from
 * a prompt in this terminal, a `buckle approve` elsewhere, a POST to the workspace's
 * /setup/approvals, or whatever a webhook put in front of the owner. One home, so the node's own
 * workspace and a registered child workspace are delivered the same way.
 */
export function createApprovalDelivery(options: ApprovalDeliveryOptions & { prompt: boolean }): ApprovalChannel {
  return createWaitingApprovalChannel({
    approvals: options.approvals,
    timeoutMs: options.config.approvalTimeoutMs,
    notify: options.config.approvalWebhook
      ? createWebhookNotifier({ url: options.config.approvalWebhook, serverId: options.config.serverId, workspaceId: options.workspaceId, token: options.config.reportToken, approvalKey: options.config.ringsApprovalKey })
      : undefined,
    prompt: options.prompt ? createCliApprovalChannel() : undefined,
  })
}

/**
 * A child workspace has no terminal of its own — the node's own process owns stdin — so it holds
 * a call open only where a configured webhook can reach somebody. With nobody to reach, waiting
 * out a grace period nobody can answer within delays the call for nothing; the invoker relays
 * `approval_required` instead, and that instruction names the node and the workspace.
 */
export function createChildApprovalDelivery(options: ApprovalDeliveryOptions): ApprovalChannel {
  if (!options.config.approvalWebhook) return createDeferredApprovalChannel()
  return createApprovalDelivery({ ...options, prompt: false })
}
