import type { H3Event } from 'h3'
import type { JsonValue } from '@5straps/protocol'
import type { SetupViews } from '../../../../common/services/setup/setup-views.js'
import type { ManagedWorkspace, WorkspaceManager } from '../../../../common/services/workspaces/workspace-manager.js'
import { withTransportAudit } from '../../../common/server/utils/audit.js'
import { isMutation } from '../../../common/server/utils/guards.js'
import { readJson, SETUP_BODY_LIMIT } from '../../../common/server/utils/body.js'
import { mapFailures } from '../../../common/server/utils/errors.js'
import { defineOperationHandler } from '../../../common/server/utils/operation.js'
import { useServices } from '../../../common/server/utils/services.js'
import { NODE_WORKSPACE, targetId } from '../../../common/server/utils/target.js'
import { withRegistryAudit, withSetupAudit } from './audit.js'
import { approvalProofDeadline, REGISTRY_REFUSED, registryTransportTool, requireAdmin, requireAdminHttp, requireNodeAdminCredential, SETUP_REFUSED, type AdminAccess } from './guards.js'

interface SetupCall {
  event: H3Event
  /** Who the guard let in: admin:<workspace>, or key:<fingerprint> for a signed request. */
  actor: string
  proofDeadline?: number
  workspace: ManagedWorkspace
  views: SetupViews
  /** The request body as JSON, read up to 64 KiB (413 past it); undefined when it is not JSON. */
  body(): Promise<unknown>
  /** The query string as plain values. */
  query(): Record<string, string>
  /** What the route did, for its audit result entry: hashed or public values only. */
  audit(args: Record<string, JsonValue>): void
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
    preflight: [requireAdminHttp, requireNodeAdminCredential(targetId)],
    guards: [event => requireAdmin(accessOf(event), SETUP_REFUSED)(event)],
    handler: async (event, scope) => {
      const workspace = await useSetupTarget(event, { setup: !definition.active })
      const resource = typeof definition.resource === 'function' ? definition.resource(event) : definition.resource
      const audited: Record<string, JsonValue> = {}
      const call: SetupCall = { event, actor: scope.context.actor ?? '', proofDeadline: approvalProofDeadline(event), workspace, views: useServices(event).getSetupViews(), body: () => readJson(event, SETUP_BODY_LIMIT), query: () => Object.fromEntries(event.url.searchParams), audit: args => { Object.assign(audited, args) } }
      return mapFailures(() => withSetupAudit(event, { actions: workspace.runtime.actions, workspaceId: workspace.runtime.workspaceId, resource, actorId: call.actor, args: () => audited }, async () => definition.handler(call)))
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
  /** Runs one registry change inside its workspace_* attempt and result entries on the node's log, which name the actor. */
  audited<T>(input: { tool: string; workspaceId: string }, run: () => Promise<T>): Promise<T>
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
    preflight: [requireAdminHttp, requireNodeAdminCredential(() => NODE_WORKSPACE)],
    // A signed change to the registry needs a node-scoped key (owner decision D10).
    guards: [requireAdmin(definition.access, REGISTRY_REFUSED, () => NODE_WORKSPACE, { registry: true })],
    handler: async (event, scope) => {
      const services = useServices(event)
      const { actions } = await services.getWorkspaceRuntime()
      const actorId = scope.context.actor ?? ''
      const call: RegistryCall = {
        event, workspaces: await services.getWorkspaces(), views: services.getSetupViews(),
        audited: (input, run) => withRegistryAudit(actions, { ...input, actorId }, run),
        body: () => readJson(event, SETUP_BODY_LIMIT), query: () => Object.fromEntries(event.url.searchParams),
      }
      return mapFailures(() => withTransportAudit(event, actions, { tool: registryTransportTool(event), workspaceId: NODE_WORKSPACE, required: isMutation(event), actorId }, async () => definition.handler(call)))
    },
  })
}
