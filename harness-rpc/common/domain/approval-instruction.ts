import type { ApprovalRequest, GrantScope, JsonValue, PermissionRuleId } from '@5straps/protocol'
import { describeExpiry } from './approval-deadline.js'

/** The node's own workspace, whose requests the plain command already answers. */
const DEFAULT_WORKSPACE = 'default'

/**
 * Controls (C0, DEL, C1), format characters (bidirectional marks and overrides, zero-width
 * characters, the soft hyphen, tag characters) and the Unicode line and paragraph separators:
 * characters a terminal acts on or hides instead of showing, so an agent-chosen subject could move
 * the cursor, reorder the line a person reads before approving, or pass for a different name.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * What an agent chose (tool name, subject, reason) as a person sees it: every character above shown
 * as its escape, `\u001b` in the Basic Multilingual Plane and `\u{e0041}` above it. Every rendering
 * of agent-controlled text for a person goes through this.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, character => {
    const code = character.codePointAt(0)!
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
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

/** The command that denies one request: the only decision an ask recorded before this build takes (owner decision D17). */
export function denyCommand(input: { request: ApprovalRequest; workspaceId?: string }): string {
  const workspace = input.workspaceId && input.workspaceId !== DEFAULT_WORKSPACE ? ` --workspace ${input.workspaceId}` : ''
  return `buckle approve ${input.request.token} --deny${workspace}`
}

/**
 * The command that shows every waiting ask's whole action (owner decision D17): what a relayed instruction
 * sends a person to first, before any command that decides.
 */
export function reviewCommand(input: { workspaceId?: string }): string {
  return `buckle approvals${input.workspaceId && input.workspaceId !== DEFAULT_WORKSPACE ? ` --workspace ${input.workspaceId}` : ''}`
}

/**
 * What a person is told about a request that is waiting: what it wants, where it is waiting, how
 * long it stays answerable, the command that shows its whole action, and only then the command that
 * answers it (owner decision D17: a relayed line never stands in for the action). One home, because the
 * same lines go to an MCP client's user, a terminal and an approval webhook, and an instruction that
 * named neither the node nor the workspace was not actionable on a node serving several.
 */
export function describeApprovalRequest(input: { request: ApprovalRequest; workspaceId?: string; nodeName?: string }): string[] {
  const { request } = input
  return [
    printable(request.reason),
    `subject: ${printable(request.subject)}`,
    `${describeExpiry(request.expiresAt)}`,
    ...(input.nodeName || input.workspaceId ? [`waiting on ${[input.nodeName ? `node ${input.nodeName}` : null, input.workspaceId ? `workspace ${input.workspaceId}` : null].filter(Boolean).join(', ')}`] : []),
    `see the whole action with: ${reviewCommand(input)}`,
    `then approve with: ${approveCommand(input)} (it shows the action again and asks to confirm)`,
  ]
}

/**
 * What every route says of an ask recorded before this build: its whole call was never kept, so it is shown
 * in part and nobody approves it; it can be denied, or the call re-sent to ask again (owner decision D17).
 */
export const RECORDED_BEFORE_NOTE = 'recorded before this build: its whole call was not kept, so it cannot be approved; deny it, or have the agent re-send the call to ask again'

/** Arguments past this size get a line naming their size before anything else, so a person knows how much follows. */
export const LARGE_ACTION_BYTES = 64 * 1_024

/** An action as a person decides on it: the whole call and where it runs (owner decision D17). */
export interface ShownAction {
  node?: string
  workspace?: string
  rule: string
  subject: string
  reason: string
  description: string | null
  cwd: string | null
  effects: readonly string[] | null
  arguments: JsonValue | null
}

/** A call as an approver shows it: the one the ask recorded whole (owner decision D17). */
export interface ShownCall {
  arguments: JsonValue
  cwd: string
  description: string | null
  effects?: readonly string[]
}

/** One waiting ask as an approver shows it: the request, and the whole call it recorded when there is one. */
export interface ShownAsk {
  tool: string
  rule: PermissionRuleId
  subject: string
  reason: string
  expiresAt: string
  /** Named only when the ask comes from a registered workspace. */
  workspaceId?: string
  node?: string
  /** Absent for an ask recorded before this build: it is shown with RECORDED_BEFORE_NOTE and never approved. */
  call?: ShownCall
}

/**
 * What every route that decides shows before a decision, so the serve terminal, `buckle approvals --watch`,
 * `buckle approve` and MCP elicitation read alike (owner decision D17): the ask, then its whole action.
 */
export function describeAsk(ask: ShownAsk): string[] {
  const head = [
    `${printable(ask.tool)} needs approval`,
    `  ${printable(ask.reason)}`,
    `  subject: ${printable(ask.subject)}`,
    ...(ask.workspaceId && ask.workspaceId !== DEFAULT_WORKSPACE ? [`  workspace: ${printable(ask.workspaceId)}`] : []),
    `  ${describeExpiry(ask.expiresAt)}`,
  ]
  const { call } = ask
  if (!call) return [...head, `  ${RECORDED_BEFORE_NOTE}`]
  return [...head, ...describeAction({
    ...(ask.node === undefined ? {} : { node: ask.node }), workspace: ask.workspaceId ?? DEFAULT_WORKSPACE, rule: ask.rule, subject: ask.subject, reason: ask.reason,
    description: call.description, cwd: call.cwd, effects: call.effects ?? null, arguments: call.arguments,
  })]
}

/**
 * The lines every approver shows for one action (owner decision D17): a size line first when the arguments
 * pass LARGE_ACTION_BYTES, then the node and workspace, the node's summary, the rule, subject and reason, the
 * directory, every judged effect and the whole arguments as indented JSON. Nothing is cut or paged; every
 * line passes through printable(), since the agent chose most of it.
 */
export function describeAction(action: ShownAction): string[] {
  const shown = action.arguments === null ? null : JSON.stringify(action.arguments, null, 2)
  const bytes = shown === null ? 0 : Buffer.byteLength(shown)
  return [
    ...(bytes > LARGE_ACTION_BYTES ? [`  size:     ${bytes} bytes of arguments, every one shown below`] : []),
    ...(action.node === undefined ? [] : [`  node:     ${printable(action.node)}`]),
    ...(action.workspace === undefined ? [] : [`  workspace: ${printable(action.workspace)}`]),
    `  does:     ${action.description === null ? 'not described' : printable(action.description)}`,
    `  rule:     ${printable(action.rule)}`,
    `  subject:  ${printable(action.subject)}`,
    `  reason:   ${printable(action.reason)}`,
    `  in:       ${action.cwd === null ? 'not recorded' : printable(action.cwd)}`,
    ...(action.effects === null ? ['  effects:  not recorded'] : action.effects.length === 0 ? ['  effects:  none'] : action.effects.map((effect, index) => `${index === 0 ? '  effects:  ' : '            '}${printable(effect)}`)),
    ...(shown === null ? ['  arguments: not recorded'] : ['  arguments:', ...shown.split('\n').map(line => `    ${printable(line)}`)]),
  ]
}
