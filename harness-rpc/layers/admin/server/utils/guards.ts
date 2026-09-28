import type { H3Event } from 'h3'
import type { Guard } from '@5straps/runtime/nitro'
import { recordRefusal, recordTransportRefusal } from '../../../common/server/utils/audit.js'
import { notFound } from '../../../common/server/utils/errors.js'
import { authorization, checkCredential, isMutation, type RefusalAudit } from '../../../common/server/utils/guards.js'
import { useServices } from '../../../common/server/utils/services.js'
import { NODE_WORKSPACE, targetId } from '../../../common/server/utils/target.js'

/** What an admin route does: reads (every GET), changes (workspaces, policy, grants, history, workbenches), or answers an approval. */
export type AdminAccess = 'inspection' | 'setup' | 'approval'
type Credential = 'admin'

/**
 * The credential each admin guard accepts (plan section C, temporary administration boundary): all
 * three take the addressed workspace's admin credential for now. When one is replaced, such as by
 * proof-of-possession setup sessions, its entry here changes and nothing else. No agent or workbench
 * credential passes any of them.
 */
const ACCEPTS: Readonly<Record<AdminAccess, Credential>> = { inspection: 'admin', setup: 'admin', approval: 'admin' }

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
 * The guard for one kind of admin access to the addressed workspace. A node without BUCKLE_ADMIN_TOKEN
 * has no owner's face: 404, as when the face was not mounted. The actor is admin:<workspace>.
 */
export function requireAdmin(access: AdminAccess, refusal: RefusalAudit): Guard {
  return async (event) => {
    const workspaceId = targetId(event)
    const workspaces = await useServices(event).getWorkspaces()
    if (workspaceId === NODE_WORKSPACE && !workspaces.hasAdminCredential(NODE_WORKSPACE)) throw notFound()
    const credential = ACCEPTS[access]
    await checkCredential(event, { verify: () => (credential === 'admin' && workspaces.authenticateAdmin(workspaceId, authorization(event)) ? true : null), refusal })
    return { actor: `admin:${workspaceId}`, workspaceId }
  }
}

export const requireInspection = (refusal: RefusalAudit = SETUP_REFUSED): Guard => requireAdmin('inspection', refusal)
export const requireSetup = (refusal: RefusalAudit = SETUP_REFUSED): Guard => requireAdmin('setup', refusal)
export const requireApproval = (refusal: RefusalAudit = SETUP_REFUSED): Guard => requireAdmin('approval', refusal)

/** A catch-all reads for GET and HEAD and changes for anything else. */
export function accessFor(event: H3Event): AdminAccess {
  return isMutation(event) ? 'setup' : 'inspection'
}
