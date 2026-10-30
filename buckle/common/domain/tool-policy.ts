import { isWorkspaceToolAllowed, type WorkspacePolicy } from '@5straps/protocol'

/**
 * The tool each later file tool writes or reads as. A workspace that denied fs_write or fs_read (`buckle policy deny-tool
 * fs_write`) before the copy tools, before fs_delete, fs_move, and fs_apply_patch (the fs-verbs brief), or before the
 * history pack's history_restore and history_list (slice D) existed meant that no one changes or reads files through the
 * node; each of these is a tool of its own, so by name alone it would have stayed open when the node was upgraded.
 */
const SIBLINGS: Readonly<Record<string, string>> = { fs_receive: 'fs_write', fs_send: 'fs_read', fs_delete: 'fs_write', fs_move: 'fs_write', fs_apply_patch: 'fs_write', history_restore: 'fs_write', history_list: 'fs_read' }

/**
 * Whether the workspace's tool policy lets a tool run: its allowlist and denylist by name, and for each tool SIBLINGS
 * names also a denial of the tool it writes or reads as. An allowlist still has to name each of them to allow it.
 */
export function isToolAllowed(policy: Pick<WorkspacePolicy, 'tools'>, tool: string): boolean {
  return toolPolicyBlockers(policy, tool).length === 0
}

export function toolPolicyBlockers(policy: Pick<WorkspacePolicy, 'tools'>, tool: string): string[] {
  const sibling = Object.hasOwn(SIBLINGS, tool) ? SIBLINGS[tool] : undefined
  const direct = isWorkspaceToolAllowed(policy, tool) ? [] : [tool]
  const inherited = sibling !== undefined && policy.tools?.deny.includes(sibling) ? [sibling] : []
  return [...direct, ...inherited]
}
