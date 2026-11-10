import { getRouterParam, type H3Event } from 'h3'
import type { JsonValue } from '@5straps/protocol'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import type { DeviceProof } from '../../../../common/services/approvals/device-proof.js'
import type { SetupViews } from '../../../../common/services/setup/setup-views.js'
import type { ManagedWorkspace, WorkspaceManager } from '../../../../common/services/workspaces/workspace-manager.js'
import { withTransportAudit } from '../../../common/server/utils/audit.js'
import { readJson, SETUP_BODY_LIMIT } from '../../../common/server/utils/body.js'
import { mapFailures, notFound } from '../../../common/server/utils/errors.js'
import { defineOperationHandler } from '../../../common/server/utils/operation.js'
import { useServices } from '../../../common/server/utils/services.js'
import { NODE_LEVEL, namedWorkspace, targetId } from '../../../common/server/utils/target.js'
import { isMutation } from '../../../common/server/utils/guards.js'
import { ignoresWarning, withRegistryAudit, withSetupAudit } from './audit.js'
import { REGISTRY_REFUSED, registryTransportTool, requireAdmin, requireAdminHttp, requireNodeAdminCredential, SETUP_REFUSED, type AdminAccess } from './guards.js'

interface SetupRequest {
  event: H3Event
  /** Who the guard let in: admin:<workspace>, or key:<fingerprint> for a signed request. */
  actor: string
  /** What the request verifier minted for a request an enrolled key signed for an approval. */
  proof?: DeviceProof
  views: SetupViews
  /** The request body as JSON, read up to 64 KiB (413 past it); undefined when it is not JSON. */
  body(): Promise<unknown>
  /** The query string as plain values. */
  query(): Record<string, string>
  /** What the route did, for its audit result entry: hashed or public values only. */
  audit(args: Record<string, JsonValue>): void
}

interface SetupScope {
  /** The id the route serves (D85, Q15): the addressed workspace's, or NODE_LEVEL for a node-level session route. */
  workspaceId: string
}

interface WorkspaceSetupScope extends SetupScope {
  workspace: ManagedWorkspace
}

interface SetupDefinition<Call> {
  access: AdminAccess | ((event: H3Event) => AdminAccess)
  resource: string | ((event: H3Event) => string)
  handler: (call: Call) => unknown
}

interface SetupTarget<Scope extends SetupScope> {
  scope: Scope
  actions: ActionLog
}

/**
 * One route of the owner's face for a workspace (node level, and its /workspaces/[id]/ twin): the
 * admin guard for its kind of access, the workspace resolved, then the admin audit around the work,
 * with service failures answered by their status. `active` resolves as an agent route does, so a
 * disabled workspace answers 409; the rest reach a disabled or retired workspace too.
 */
export function defineSetupHandler(definition: SetupDefinition<SetupRequest & WorkspaceSetupScope> & {
  active?: boolean
  /** The catch-all: a path no face serves, whose 404 says nothing more at the node level either. */
  unknown?: boolean
}) {
  return defineSetupOperation<WorkspaceSetupScope>(definition, async ({ event, resource, actor }) => {
    if (!namedWorkspace(event)) {
      const actions = await useServices(event).getNodeActions()
      // No workspace is served at the node level (D85, Q15): the call is recorded on the node's log, as a probe of
      // an unknown path is, then answered 404 naming where the workspaces are.
      return mapFailures(() => withSetupAudit(event, { actions, workspaceId: NODE_LEVEL, resource, actorId: actor }, async () => { throw definition.unknown ? notFound() : notFound(NODE_LEVEL_REFUSAL) }))
    }
    const workspace = await useSetupTarget(event, { setup: !definition.active })
    return { scope: { workspace, workspaceId: workspace.runtime.workspaceId }, actions: workspace.runtime.actions }
  })
}

/** Served at the node level too (the node-scoped setup session), with workspaceId NODE_LEVEL. */
export function defineSetupSessionHandler(definition: SetupDefinition<SetupRequest & SetupScope> & { access: 'session' | 'setup'; resource: 'sessions' }) {
  return defineSetupOperation<SetupScope>(definition, async ({ event }) => {
    if (!namedWorkspace(event)) {
      const actions = await useServices(event).getNodeActions()
      // The node-scoped setup session: no workspace, so the handler reads workspaceId NODE_LEVEL and the node log.
      return { scope: { workspaceId: NODE_LEVEL }, actions }
    }
    const workspace = await useSetupTarget(event, { setup: true })
    return { scope: { workspaceId: workspace.runtime.workspaceId }, actions: workspace.runtime.actions }
  })
}

function defineSetupOperation<Scope extends SetupScope>(definition: SetupDefinition<SetupRequest & Scope>, targetOf: (input: { event: H3Event; resource: string; actor: string }) => Promise<SetupTarget<Scope>>) {
  const accessOf = (event: H3Event) => (typeof definition.access === 'function' ? definition.access(event) : definition.access)
  return defineOperationHandler({
    preflight: [requireAdminHttp, requireNodeAdminCredential],
    guards: [event => requireAdmin(accessOf(event), SETUP_REFUSED)(event)],
    handler: async (event, scope) => {
      const resource = typeof definition.resource === 'function' ? definition.resource(event) : definition.resource
      const actor = scope.context.actor ?? ''
      const target = await targetOf({ event, resource, actor })
      const audited: Record<string, JsonValue> = {}
      const proof = actor.startsWith('key:') ? (await useServices(event).getRequestVerifier()).approvalProof(event) : undefined
      const call: SetupRequest & Scope = { ...target.scope, event, actor, proof, views: useServices(event).getSetupViews(), body: () => readJson(event, SETUP_BODY_LIMIT), query: () => Object.fromEntries(event.url.searchParams), audit: args => { Object.assign(audited, args) } }
      return mapFailures(() => withSetupAudit(event, { actions: target.actions, workspaceId: target.scope.workspaceId, resource, actorId: call.actor, args: () => audited }, async () => definition.handler(call)))
    },
  })
}

const NODE_LEVEL_REFUSAL = 'No workspace is served at the node level: address one at /workspaces/<id>/setup/..., by its id or its name; GET /setup/workspaces lists them'

/**
 * The addressed workspace as the owner's face opens it: failures with their full messages, since only its admin
 * credential reaches here. No workspace is served at the node level since the node's own folder became one of its
 * workspaces (D85, Q15): a workspace route there answers 404, naming where the workspaces are.
 */
async function useSetupTarget(event: H3Event, options: { setup: boolean }): Promise<ManagedWorkspace> {
  if (!namedWorkspace(event)) throw notFound(NODE_LEVEL_REFUSAL)
  const workspaces = await useServices(event).getWorkspaces()
  return mapFailures(() => workspaces.resolve(targetId(event), options))
}

/** The workspace a registry route's `workspaceId` parameter names, by id or by name (D85, Q15): its id, or the handle as typed where none matches. */
export function registryTarget(event: H3Event, workspaces: Pick<WorkspaceManager, 'lookup'>): string {
  const handle = getRouterParam(event, 'workspaceId', { decode: true }) ?? ''
  return workspaces.lookup(handle)?.id ?? handle
}

interface RegistryCall {
  event: H3Event
  workspaces: WorkspaceManager
  views: SetupViews
  /** Runs one registry change inside its workspace_* attempt and result entries on the node's log, which name the actor. */
  audited<T>(input: { tool: string; workspaceId: string; workspaceName?: string; named?: (value: T) => { workspaceId: string; workspaceName: string } }, run: () => Promise<T>): Promise<T>
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
    preflight: [requireAdminHttp, requireNodeAdminCredential],
    // A signed change to the registry needs a node-scoped key (owner decision D10).
    guards: [requireAdmin(definition.access, REGISTRY_REFUSED, async () => NODE_LEVEL, { registry: true })],
    handler: async (event, scope) => {
      const services = useServices(event)
      const actions = await services.getNodeActions()
      const actorId = scope.context.actor ?? ''
      const ignoreWarning = ignoresWarning(event)
      const call: RegistryCall = {
        event, workspaces: await services.getWorkspaces(), views: services.getSetupViews(),
        audited: (input, run) => withRegistryAudit(actions, { ...input, actorId, ignoreWarning }, run),
        body: () => readJson(event, SETUP_BODY_LIMIT), query: () => Object.fromEntries(event.url.searchParams),
      }
      // A read waits for no record, as a setup read writes no attempt; ignoring the warning queues a change's attempt too.
      return mapFailures(() => withTransportAudit(actions, { tool: registryTransportTool(event), workspaceId: NODE_LEVEL, attempt: isMutation(event) && !ignoreWarning ? 'owner' : 'queued', actorId }, async () => definition.handler(call)))
    },
  })
}
