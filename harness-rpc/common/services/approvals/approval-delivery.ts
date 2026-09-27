import { createCliApprovalChannel } from '../../adapters/approval/cli-approval-channel.js'
import { createWaitingApprovalChannel } from '../../adapters/approval/waiting-approval-channel.js'
import { createWebhookNotifier } from '../../adapters/approval/webhook-notifier.js'
import type { BuckleConfig } from '../../runtime/config.js'
import type { ApprovalChannel } from '../../types/ports/approval-channel.js'
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
 * Child workspaces use the same wait setting. The owner can answer with the workspace CLI
 * even when no webhook or terminal is attached.
 */
export function createChildApprovalDelivery(options: ApprovalDeliveryOptions): ApprovalChannel {
  return createApprovalDelivery({ ...options, prompt: false })
}
