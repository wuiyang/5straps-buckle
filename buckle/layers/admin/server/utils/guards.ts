import { getRouterParam, type H3Event } from 'h3'
import type { Guard } from '@5straps/runtime/nitro'
import { isSignedRequest, type SignedRequestPayload, type SignedRequestPurpose } from '@5straps/protocol/signed-request'
import type { SetupSessions } from '../../../../common/services/access/setup-sessions.js'
import { recordRefusal, recordTransportRefusal, nodeActions } from '../../../common/server/utils/audit.js'
import { readBody, SETUP_BODY_LIMIT } from '../../../common/server/utils/body.js'
import { notFound } from '../../../common/server/utils/errors.js'
import { authorization, checkCredential, isMutation, type RefusalAudit } from '../../../common/server/utils/guards.js'
import { useServices } from '../../../common/server/utils/services.js'
import { canonicalTargetId, NODE_LEVEL } from '../../../common/server/utils/target.js'

/**
 * What an admin route does: reads (every GET), changes (workspaces, policy, grants, history,
 * workbenches), answers an approval, or opens a setup session for a person's key.
 */
export type AdminAccess = 'inspection' | 'setup' | 'approval' | 'session'
type Credential = 'admin' | SignedRequestPurpose

/**
 * The credentials each admin guard accepts (plan section C, temporary administration boundary): the
 * addressed workspace's admin credential, and on setup and approval a request an enrolled client key
 * signed for that purpose (owner ruling H4 of 2026-09-28). A signed setup change names the key's open
 * setup session, which the request refreshes; the request that opens one names none (B24).
 * Inspection stays on the admin credential. No agent or workbench credential passes any of them.
 */
const ACCEPTS: Readonly<Record<AdminAccess, readonly Credential[]>> = { inspection: ['admin'], setup: ['admin', 'buckle-setup'], approval: ['admin', 'buckle-approval'], session: ['admin', 'buckle-setup'] }

/** A per-workspace setup route's refusal, as the setup face audited it before the move. */
export const SETUP_REFUSED: RefusalAudit = {
  node: ({ actions, status }) => recordRefusal(actions, { tool: 'setup_auth_rejected', workspaceId: NODE_LEVEL, sessionId: 'http-untrusted', status }),
  named: 'workspace_setup_auth_rejected',
}

/** A registry route's refusal: the transport audit took in the credential check. Registry routes have no twin. */
export const REGISTRY_REFUSED: RefusalAudit = {
  node: ({ event, actions, status }) => recordTransportRefusal(actions, { tool: registryTransportTool(event), workspaceId: NODE_LEVEL, status }),
  named: 'workspace_setup_auth_rejected',
}

export function registryTransportTool(event: H3Event): string {
  return `http_workspace_registry_${event.req.method.toLowerCase()}`
}

/**
 * The experimental flag (owner decision D8), checked before readiness: with it off, an admin route
 * answers the router's 404 while the node starts and closes too, never a 503 that shows the route
 * is there (review L9 of B23-B25).
 */
export const requireAdminHttp: Guard = (event) => {
  if (!useServices(event).adminHttp()) throw notFound()
}

/**
 * A node without BUCKLE_ADMIN_TOKEN has no owner's face: its admin routes answer the router's 404, as when
 * the face was not mounted, and, known from the settings before start, answer it while the node starts and
 * closes too, never a 503 (review item 23 of the proof-of-possession fixes). Every workspace's face is the
 * node's credential's since the workspace model retired the per-workspace credentials (D85, Q15).
 */
export const requireNodeAdminCredential: Guard = (event) => {
  if (!useServices(event).nodeAdminCredential()) throw notFound()
}

/**
 * The guard for one kind of admin access to the addressed workspace, or to the one `target` names.
 * The whole layer is experimental (owner decision D8): until BUCKLE_EXPERIMENTAL_ADMIN_HTTP is on,
 * every route of it answers the router's 404 before anything is read or audited, admin credential or
 * not; a node without BUCKLE_ADMIN_TOKEN answers 404 at the node level (both preflights, run before
 * this). The actor is admin:<workspace> for the admin credential and key:<fingerprint> for a signed
 * request.
 */
export function requireAdmin(access: AdminAccess, refusal: RefusalAudit, target: (event: H3Event) => Promise<string> = canonicalTargetId, options: { registry?: boolean } = {}): Guard {
  const registry = options.registry === true
  return async (event) => {
    if (!useServices(event).adminHttp()) throw notFound()
    const workspaces = await useServices(event).getWorkspaces()
    const purpose = ACCEPTS[access].find((credential): credential is SignedRequestPurpose => credential !== 'admin')
    const found = await checkCredential(event, {
      // The path's handle is looked up by id or by name (D85, Q15); a signed request is bound to the id it resolves to.
      verify: async () => {
        const signed = isSignedRequest(authorization(event))
        // The admin credential is the node's, compared before the registry is read: a caller without it learns nothing, the registry's state included.
        if (!signed && !workspaces.authenticateAdmin(authorization(event))) return null
        const workspaceId = await target(event)
        const actor = signed ? (purpose ? await verifySigned(event, { access, purpose, workspaceId, registry }) : null) : `admin:${workspaceId}`
        return actor === null ? null : { actor, workspaceId }
      },
      refusal,
    })
    return found
  }
}

/**
 * A request an enrolled client key signed for this purpose, node, workspace, method, path and exact
 * body, with a key whose scope covers it. A refusal is a bare 401 to the caller; its reason, and the
 * key the payload claims when it could be read, are audited on the node's log for the owner.
 */
async function verifySigned(event: H3Event, input: { access: AdminAccess; purpose: SignedRequestPurpose; workspaceId: string; registry: boolean }): Promise<string | null> {
  const services = useServices(event)
  // The path's handle, by id or by name, is what a client signs for (D85, Q15); the key's scope is judged against the id it resolves to.
  const workspaceHandle = getRouterParam(event, 'id', { decode: true })
  const verdict = await (await services.getRequestVerifier()).verify({
    requestIdentity: event, authorization: authorization(event), purpose: input.purpose, workspaceId: input.workspaceId, registry: input.registry,
    ...(workspaceHandle === undefined ? {} : { workspaceHandle }),
    method: event.req.method, path: `${event.url.pathname}${event.url.search}`, body: await readBody(event, SETUP_BODY_LIMIT),
  })
  const refused = verdict.ok ? await sessionRefusal({ access: input.access, payload: verdict.payload, workspaceId: input.workspaceId, sessions: await services.getSetupSessions() }) : verdict.reason
  if (!refused && verdict.ok) {
    return `key:${verdict.payload.keyId}`
  }
  const claimedKeyId = verdict.ok ? verdict.payload.keyId : verdict.claimedKeyId
  recordRefusal(await nodeActions(event), {
    tool: 'setup_signed_request_refused', workspaceId: NODE_LEVEL, sessionId: 'http-untrusted', status: 401, detail: refused ?? 'refused',
    ...(claimedKeyId === undefined ? {} : { args: { claimedKeyId } }),
  })
  return null
}

/**
 * B24: a signed setup change names an open setup session of its key and workspace, and is the
 * activity that refreshes it; the request that opens a session names none. Only a request that
 * verified, unreplayed, gets here, so neither a forged nor a replayed request refreshes anything.
 */
async function sessionRefusal(input: { access: AdminAccess; payload: SignedRequestPayload; workspaceId: string; sessions: SetupSessions }): Promise<string | null> {
  if (input.access === 'session') return input.payload.session === undefined ? null : 'session_not_expected'
  if (input.access !== 'setup') return null
  if (input.payload.session === undefined) return 'session_required'
  const session = await input.sessions.touch({ id: input.payload.session, keyId: input.payload.keyId, workspaceId: input.workspaceId })
  return session ? null : 'session_closed'
}

/** A catch-all reads for GET and HEAD and changes for anything else. */
export function accessFor(event: H3Event): AdminAccess {
  return isMutation(event) ? 'setup' : 'inspection'
}
