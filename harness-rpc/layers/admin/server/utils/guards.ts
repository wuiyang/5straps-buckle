import type { H3Event } from 'h3'
import type { Guard } from '@5straps/runtime/nitro'
import { isSignedRequest, type SignedRequestPurpose } from '@5straps/protocol/signed-request'
import { recordRefusal, recordTransportRefusal, tolerantLog, nodeActions } from '../../../common/server/utils/audit.js'
import { readBody, SETUP_BODY_LIMIT } from '../../../common/server/utils/body.js'
import { notFound } from '../../../common/server/utils/errors.js'
import { authorization, checkCredential, isMutation, type RefusalAudit } from '../../../common/server/utils/guards.js'
import { useServices } from '../../../common/server/utils/services.js'
import { NODE_WORKSPACE, targetId } from '../../../common/server/utils/target.js'

/** What an admin route does: reads (every GET), changes (workspaces, policy, grants, history, workbenches), or answers an approval. */
export type AdminAccess = 'inspection' | 'setup' | 'approval'
type Credential = 'admin' | SignedRequestPurpose

/**
 * The credentials each admin guard accepts (plan section C, temporary administration boundary): the
 * addressed workspace's admin credential on all three, and on setup and approval a request an
 * enrolled client key signed for that purpose (owner ruling H4 of 2026-09-28, B23). Inspection stays
 * on the admin credential. No agent or workbench credential passes any of them.
 */
const ACCEPTS: Readonly<Record<AdminAccess, readonly Credential[]>> = { inspection: ['admin'], setup: ['admin', 'buckle-setup'], approval: ['admin', 'buckle-approval'] }

/** A per-workspace setup route's refusal, as the setup face audited it before the move. */
export const SETUP_REFUSED: RefusalAudit = {
  node: ({ actions, status }) => recordRefusal(actions, { tool: 'setup_auth_rejected', workspaceId: NODE_WORKSPACE, sessionId: 'http-untrusted', status }),
  named: 'workspace_setup_auth_rejected',
}

/** A registry route's refusal: the transport audit took in the credential check. Registry routes have no twin. */
export const REGISTRY_REFUSED: RefusalAudit = {
  node: ({ event, actions, status }) => recordTransportRefusal(actions, { tool: registryTransportTool(event), workspaceId: NODE_WORKSPACE, status }),
  named: 'workspace_setup_auth_rejected',
}

export function registryTransportTool(event: H3Event): string {
  return `http_workspace_registry_${event.req.method.toLowerCase()}`
}

/**
 * The guard for one kind of admin access to the addressed workspace, or to the one `target` names. A
 * node without BUCKLE_ADMIN_TOKEN has no owner's face: 404, as when the face was not mounted. The
 * actor is admin:<workspace> for the admin credential and key:<fingerprint> for a signed request.
 */
export function requireAdmin(access: AdminAccess, refusal: RefusalAudit, target: (event: H3Event) => string = targetId): Guard {
  return async (event) => {
    const workspaceId = target(event)
    const workspaces = await useServices(event).getWorkspaces()
    if (workspaceId === NODE_WORKSPACE && !workspaces.hasAdminCredential(NODE_WORKSPACE)) throw notFound()
    const purpose = ACCEPTS[access].find((credential): credential is SignedRequestPurpose => credential !== 'admin')
    const actor = await checkCredential(event, {
      verify: () => (isSignedRequest(authorization(event))
        ? purpose ? verifySigned(event, { purpose, workspaceId }) : null
        : workspaces.authenticateAdmin(workspaceId, authorization(event)) ? `admin:${workspaceId}` : null),
      refusal,
    })
    return { actor, workspaceId }
  }
}

/**
 * A request an enrolled client key signed for this purpose, workspace, method, path and exact body.
 * A refusal is a bare 401 to the caller; its reason is audited on the node's log for the owner.
 */
async function verifySigned(event: H3Event, input: { purpose: SignedRequestPurpose; workspaceId: string }): Promise<string | null> {
  const verdict = await (await useServices(event).getRequestVerifier()).verify({
    authorization: authorization(event), purpose: input.purpose, workspaceId: input.workspaceId,
    method: event.req.method, path: `${event.url.pathname}${event.url.search}`, body: await readBody(event, SETUP_BODY_LIMIT),
  })
  if (verdict.ok) return `key:${verdict.payload.keyId}`
  await recordRefusal(tolerantLog(event, await nodeActions(event)), { tool: 'setup_signed_request_refused', workspaceId: NODE_WORKSPACE, sessionId: 'http-untrusted', status: 401, detail: verdict.reason })
  return null
}

export const requireInspection = (refusal: RefusalAudit = SETUP_REFUSED): Guard => requireAdmin('inspection', refusal)
export const requireSetup = (refusal: RefusalAudit = SETUP_REFUSED): Guard => requireAdmin('setup', refusal)
export const requireApproval = (refusal: RefusalAudit = SETUP_REFUSED): Guard => requireAdmin('approval', refusal)

/** A catch-all reads for GET and HEAD and changes for anything else. */
export function accessFor(event: H3Event): AdminAccess {
  return isMutation(event) ? 'setup' : 'inspection'
}
