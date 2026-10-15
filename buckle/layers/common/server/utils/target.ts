import { getRouterParam, type H3Event } from 'h3'
import type { ManagedWorkspace } from '../../../../common/services/workspaces/workspace-manager.js'
import { mapAgentFailures } from './errors.js'
import { useServices } from './services.js'

/** Workspace default, the node's own folder (Q15): what the owner's node-level face and a node-level workbench address. */
export const NODE_WORKSPACE = 'default'

/**
 * The workspace a request addresses: the one its /workspaces/[id]/ path names; else, on an agent's /mcp or /v1 path,
 * the one its bearer token belongs to (the workspace-model brief, item 3); else workspace default. Each operation has
 * one handler, and its /workspaces/[id]/ twin re-exports it, so this is how the one handler tells them apart (plan
 * section B, route mapping).
 */
export function targetId(event: H3Event): string {
  return getRouterParam(event, 'id') ?? event.context.tokenWorkspace ?? NODE_WORKSPACE
}

/** Whether the path named its workspace; a refusal there is audited under the workspace's own name. */
export function namedWorkspace(event: H3Event): boolean {
  return getRouterParam(event, 'id') !== undefined
}

/**
 * The addressed workspace, opened for an agent-facing route: 404 when it is unknown, 409 when it is
 * disabled or retired, and a workspace that cannot open (a stored policy that no longer loads) with
 * path-free text only (review M1 of B15-B17). The owner's routes open it with full messages
 * (layers/admin/server/utils/setup.ts).
 */
export async function useTarget(event: H3Event): Promise<ManagedWorkspace> {
  const workspaces = await useServices(event).getWorkspaces()
  return mapAgentFailures(() => workspaces.resolve(targetId(event)))
}
