import { isWorkspaceToolAllowed, type WorkspacePolicy } from '@5straps/protocol'

/**
 * The tool each of the two copy tools is the file face of. A workspace that denied fs_write or fs_read (`buckle policy
 * deny-tool fs_write`) before `buckle cp` existed meant that no one writes or reads files through the node's HTTP face;
 * the copy tools are tools of their own, so by name alone they would have stayed open when the node was upgraded.
 */
const SIBLINGS: Readonly<Record<string, string>> = { fs_receive: 'fs_write', fs_send: 'fs_read' }

/**
 * Whether the workspace's tool policy lets a tool run: its allowlist and denylist by name, and for fs_receive and fs_send
 * also a denial of the tool they copy as (fs_write, fs_read). An allowlist still has to name the copy tools to allow them.
 */
export function isToolAllowed(policy: Pick<WorkspacePolicy, 'tools'>, tool: string): boolean {
  const sibling = SIBLINGS[tool]
  return isWorkspaceToolAllowed(policy, tool) && (sibling === undefined || !(policy.tools?.deny.includes(sibling) ?? false))
}
