import type { ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeExpiry } from './approval-deadline.js'

/** The node's own workspace, whose requests the plain command already answers. */
const DEFAULT_WORKSPACE = 'default'

/** What a relay suggests: a session grant where one is offered, so a retry is not gated again. */
export function preferredScope(offered: GrantScope[]): GrantScope {
  return offered.includes('session') ? 'session' : offered[0] ?? 'once'
}

/**
 * The exact command that answers one request. A token is issued and resolved inside one
 * workspace's own state, so `buckle approve <token>` run against the node reaches a request from
 * the node's workspace and no other: a registered child workspace has to be named. The flag is
 * left off where it would say `default`, which is what every instruction printed before this.
 */
export function approveCommand(input: { request: ApprovalRequest; workspaceId?: string }): string {
  const workspace = input.workspaceId && input.workspaceId !== DEFAULT_WORKSPACE ? ` --workspace ${input.workspaceId}` : ''
  return `buckle approve ${input.request.token} --scope ${preferredScope(input.request.offeredScopes)}${workspace}`
}

/**
 * What a person is told about a request that is waiting: what it wants, where it is waiting, how
 * long it stays answerable, and the command that answers it. One home, because the same lines go
 * to an MCP client's user, a terminal and an approval webhook, and an instruction that named
 * neither the node nor the workspace was not actionable on a node serving several.
 */
export function describeApprovalRequest(input: { request: ApprovalRequest; workspaceId?: string; nodeName?: string }): string[] {
  const { request } = input
  return [
    `${request.reason}`,
    `subject: ${request.subject}`,
    `${describeExpiry(request.expiresAt)}`,
    ...(input.nodeName || input.workspaceId ? [`waiting on ${[input.nodeName ? `node ${input.nodeName}` : null, input.workspaceId ? `workspace ${input.workspaceId}` : null].filter(Boolean).join(', ')}`] : []),
    `approve with: ${approveCommand(input)}`,
  ]
}
