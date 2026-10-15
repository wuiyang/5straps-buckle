import { getRouterParam, type H3Event } from 'h3'
import type { ManagedWorkspace } from '../../../../common/services/workspaces/workspace-manager.js'
import type { NODE_SCOPE } from '../../../../common/types/ports/client-keys.js'
import { mapAgentFailures } from './errors.js'
import { useServices } from './services.js'

/**
 * The node level: a path that names no workspace, with no workspace's token. No workspace is served there since the
 * node's own folder became a workspace of its own (D85, Q15); it is the scope a key enrolled for the whole node has
 * (NODE_SCOPE), which refusals there are audited under.
 */
export const NODE_LEVEL: typeof NODE_SCOPE = 'node'

/**
 * The workspace a request addresses: the one its /workspaces/[id]/ path names, as the guard that let the request in
 * looked it up (canonicalTargetId), else, on an agent's /mcp or /v1 path, the one its bearer token belongs to (the
 * workspace-model brief, item 3); else the node level. Each operation has one handler, and its /workspaces/[id]/ twin
 * re-exports it, so this is how the one handler tells them apart (plan section B, route mapping).
 */
export function targetId(event: H3Event): string {
  return event.context.workspaceId ?? getRouterParam(event, 'id', { decode: true }) ?? event.context.tokenWorkspace ?? NODE_LEVEL
}

/**
 * The id of the workspace a /workspaces/[id]/ path names, looked up by id or by name (D85, Q15) and kept on the event
 * for every later read; the handle as typed where none matches, so the request is refused as for an unknown
 * workspace. A path that names none answers as targetId does. Throws where the registry cannot be read.
 */
export async function canonicalTargetId(event: H3Event): Promise<string> {
  if (event.context.workspaceId !== undefined) return event.context.workspaceId
  const handle = getRouterParam(event, 'id', { decode: true })
  if (handle === undefined) return targetId(event)
  const workspaces = await useServices(event).getWorkspaces()
  event.context.workspaceId = workspaces.lookup(handle)?.id ?? handle
  return event.context.workspaceId
}

/** Whether the path named its workspace; a refusal there is audited under the workspace's own id. */
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
