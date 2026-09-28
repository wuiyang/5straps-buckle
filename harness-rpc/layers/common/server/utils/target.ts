import { getRouterParam, type H3Event } from 'h3'
import type { ManagedWorkspace } from '../../../../common/services/workspaces/workspace-manager.js'
import { mapFailures } from './errors.js'
import { useServices } from './services.js'

/** The node's own workspace: every path outside /workspaces/[id]/, and /workspaces/default/ as its alias. */
export const NODE_WORKSPACE = 'default'

/**
 * The workspace a request addresses. Each operation has one handler, and its /workspaces/[id]/ twin
 * re-exports it, so this is how the one handler tells them apart (plan section B, route mapping).
 */
export function targetId(event: H3Event): string {
  return getRouterParam(event, 'id') ?? NODE_WORKSPACE
}

/** Whether the path named its workspace; a refusal there is audited under the workspace's own name. */
export function namedWorkspace(event: H3Event): boolean {
  return getRouterParam(event, 'id') !== undefined
}

/** The addressed workspace, opened: 404 when it is unknown, 409 when it is disabled or retired. */
export async function useTarget(event: H3Event, options: { setup?: boolean } = {}): Promise<ManagedWorkspace> {
  const workspaces = await useServices(event).getWorkspaces()
  return mapFailures(() => workspaces.resolve(targetId(event), options))
}
