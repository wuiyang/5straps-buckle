import type { H3Event } from 'h3'
import type { SetupViews } from '../../../../common/services/setup/setup-views.js'
import type { ManagedWorkspace, WorkspaceManager } from '../../../../common/services/workspaces/workspace-manager.js'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import { withTransportAudit } from '../../../common/server/utils/audit.js'
import { readJson, SETUP_BODY_LIMIT } from '../../../common/server/utils/body.js'
import { mapFailures } from '../../../common/server/utils/errors.js'
import { defineOperationHandler } from '../../../common/server/utils/operation.js'
import { useServices } from '../../../common/server/utils/services.js'
import { NODE_WORKSPACE, targetId } from '../../../common/server/utils/target.js'
import { withSetupAudit } from './audit.js'
import { REGISTRY_REFUSED, registryTransportTool, requireAdmin, SETUP_REFUSED, type AdminAccess } from './guards.js'

interface SetupCall {
  event: H3Event
  workspace: ManagedWorkspace
  views: SetupViews
  /** The request body as JSON, read up to 64 KiB (413 past it); undefined when it is not JSON. */
  body(): Promise<unknown>
  /** The query string as plain values. */
  query(): Record<string, string>
}

/**
 * One route of the owner's face for a workspace (node level, and its /workspaces/[id]/ twin): the
 * admin guard for its kind of access, the workspace resolved, then the admin audit around the work,
 * with service failures answered by their status. `active` resolves as an agent route does, so a
 * disabled workspace answers 409; the rest reach a disabled or retired workspace too.
 */
export function defineSetupHandler(definition: { access: AdminAccess | ((event: H3Event) => AdminAccess); resource: string | ((event: H3Event) => string); active?: boolean; handler: (call: SetupCall) => unknown }) {
  const accessOf = (event: H3Event) => (typeof definition.access === 'function' ? definition.access(event) : definition.access)
  return defineOperationHandler({
    guards: [event => requireAdmin(accessOf(event), SETUP_REFUSED)(event)],
    handler: async (event) => {
      const workspace = await useSetupTarget(event, { setup: !definition.active })
      const resource = typeof definition.resource === 'function' ? definition.resource(event) : definition.resource
      const call: SetupCall = { event, workspace, views: useServices(event).getSetupViews(), body: () => readJson(event, SETUP_BODY_LIMIT), query: () => Object.fromEntries(event.url.searchParams) }
      return withSetupAudit(event, { actions: workspace.runtime.actions, workspaceId: workspace.runtime.workspaceId, resource }, () => mapFailures(() => definition.handler(call)))
    },
  })
}

/** The addressed workspace as the owner's face opens it: failures with their full messages, since only its admin credential reaches here. */
async function useSetupTarget(event: H3Event, options: { setup: boolean }): Promise<ManagedWorkspace> {
  const workspaces = await useServices(event).getWorkspaces()
  return mapFailures(() => workspaces.resolve(targetId(event), options))
}

interface RegistryCall {
  event: H3Event
  workspaces: WorkspaceManager
  views: SetupViews
  /** The node's own log, where registry changes are audited as workspace_*. */
  actions: ActionLog
  body(): Promise<unknown>
  query(): Record<string, string>
}

/**
 * One route of the node's workspace registry (node level only): the admin guard of the node, whatever
 * the route's parameters are named, so no child's admin credential ever opens the registry (review L5
 * of B15-B17), then the http_workspace_registry_<method> transport audit around the work.
 */
export function defineRegistryHandler(definition: { access: AdminAccess; handler: (call: RegistryCall) => unknown }) {
  return defineOperationHandler({
    guards: [requireAdmin(definition.access, REGISTRY_REFUSED, () => NODE_WORKSPACE)],
    handler: async (event) => {
      const services = useServices(event)
      const { actions } = await services.getWorkspaceRuntime()
      const call: RegistryCall = { event, workspaces: await services.getWorkspaces(), views: services.getSetupViews(), actions, body: () => readJson(event, SETUP_BODY_LIMIT), query: () => Object.fromEntries(event.url.searchParams) }
      return withTransportAudit(actions, { tool: registryTransportTool(event), workspaceId: NODE_WORKSPACE }, () => mapFailures(() => definition.handler(call)))
    },
  })
}
