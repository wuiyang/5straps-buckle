import type { ApprovalWait } from '@5straps/protocol'

/**
 * How long the HTTP MCP face holds a call for a person at most (the MCP asks brief, item 1), as FILES_HOLD_MS bounds a
 * copy's (layers/common/server/utils/files.ts). An MCP client times out on its own clock, Claude Code's near a minute,
 * and the work after an approval counts against that clock too, so the hold ends well inside it: an unanswered hold
 * answers approval_required, and the client sends the same call again, which joins the ask.
 */
export const MCP_HOLD_MS = 30_000

/** The wait the HTTP MCP face gives a call: the workspace's own, at most MCP_HOLD_MS; 0, until decided, reads as the cap. */
export function mcpWait(approvalTimeoutMs: number | null): Extract<ApprovalWait, { mode: 'finite' }> {
  return { mode: 'finite', ms: Math.max(1, Math.min(approvalTimeoutMs ?? MCP_HOLD_MS, MCP_HOLD_MS)) }
}

/** The wait the stdio face gives a call: the workspace's own, which a caller's hint may shorten; none where it waits until decided. */
export function workspaceWait(approvalTimeoutMs: number | null): ApprovalWait | undefined {
  return approvalTimeoutMs === null ? undefined : { mode: 'finite', ms: approvalTimeoutMs }
}
