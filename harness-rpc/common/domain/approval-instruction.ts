import type { ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeExpiry } from './approval-deadline.js'

/** The node's own workspace, whose requests the plain command already answers. */
const DEFAULT_WORKSPACE = 'default'

/**
 * C0 and C1 controls, DEL, the Unicode line separators and the bidirectional overrides: characters a
 * terminal acts on instead of showing, so an agent-chosen subject could move the cursor or reorder
 * the line a person reads before approving.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/**
 * What an agent chose (tool name, subject, reason) as a person sees it: every character above shown
 * as its `\u001b` escape. Every rendering of an ask for a person goes through this.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

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
    printable(request.reason),
    `subject: ${printable(request.subject)}`,
    `${describeExpiry(request.expiresAt)}`,
    ...(input.nodeName || input.workspaceId ? [`waiting on ${[input.nodeName ? `node ${input.nodeName}` : null, input.workspaceId ? `workspace ${input.workspaceId}` : null].filter(Boolean).join(', ')}`] : []),
    `approve with: ${approveCommand(input)}`,
  ]
}
