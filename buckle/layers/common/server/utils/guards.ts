import { getRouterParam, type H3Event } from 'h3'
import type { Guard } from '@5straps/runtime/nitro'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import { nodeActions, recordRefusal, recordTransportRefusal, tolerantLog } from './audit.js'
import { beforeCredential, isRegistryFailure, unauthorized } from './errors.js'
import { useServices } from './services.js'
import { NODE_WORKSPACE, namedWorkspace, targetId } from './target.js'

const UNRESOLVED = 'unresolved'

/**
 * How a face audits a caller it refuses (plan section A inventory, kept through the move): at node
 * level each face has its own entry; under /workspaces/[id]/ the refusal goes on the node's log under
 * the face's name, with the workspace id only when that workspace exists.
 */
export interface RefusalAudit {
  node(input: { event: H3Event; actions: ActionLog; status: number }): Promise<void>
  named: string
}

export function authorization(event: H3Event): string | undefined {
  return event.req.headers.get('authorization') ?? undefined
}

export function isMutation(event: H3Event): boolean {
  return event.req.method !== 'GET' && event.req.method !== 'HEAD'
}

/**
 * Runs one credential check for the addressed workspace: 401 when the check fails; when the check
 * itself fails, the registry's 503, a workspace the registry refuses by its path-free message, or a
 * fixed 503 with the cause in the owner's log only (review M1 of B15-B17). Each is audited through
 * the face's refusal audit. Every guard of every layer goes through this, so none can skip the audit.
 */
export async function checkCredential<T>(event: H3Event, input: { verify: () => T | null | Promise<T | null>; refusal?: RefusalAudit }): Promise<T> {
  let verified: T | null
  try {
    verified = await input.verify()
  } catch (error) {
    const refused = beforeCredential(error)
    if (!isRegistryFailure(error)) event.context.logger?.error('A credential could not be checked', { route: event.context.matchedRoute?.route, error })
    await audit(event, input.refusal, { status: refused.status, registryReadable: !isRegistryFailure(error) })
    throw refused
  }
  if (verified === null) {
    await audit(event, input.refusal, { status: 401, registryReadable: true })
    throw unauthorized()
  }
  return verified
}

/**
 * An agent's token, read per request so a revoked token is refused at once (the workspace-model brief, item 3): on a
 * /workspaces/[id]/ path one of that workspace's tokens; on /mcp and /v1 any workspace's, which then names the
 * workspace the request runs on. Every token on the node is compared either way, so a token of no workspace and one of
 * another are the same 401, in text and in the work done. The actor is the token's id under its credential kind.
 */
export function requireAgent(refusal?: RefusalAudit): Guard {
  return async (event) => {
    const named = getRouterParam(event, 'id')
    const workspaces = await useServices(event).getWorkspaces()
    const owner = await checkCredential(event, {
      verify: () => {
        const found = workspaces.tokenOwner(authorization(event))
        return found !== null && (named === undefined || found.workspaceId === named) ? found : null
      },
      ...(refusal ? { refusal } : {}),
    })
    if (named === undefined) event.context.tokenWorkspace = owner.workspaceId
    return { actor: `agent:${owner.tokenId}`, workspaceId: owner.workspaceId }
  }
}

/**
 * A grant's refusal: on the node's log at node level, with the transport pair for a change, since a
 * workbench's transport audit took in its credential check too; under /workspaces/[id]/ on the node's
 * log under the face's name, as every other twin records its refusals.
 */
const WORKBENCH_REFUSED: RefusalAudit = {
  node: async ({ event, actions, status }) => {
    await recordRefusal(actions, { tool: 'workbench_auth_rejected', workspaceId: NODE_WORKSPACE, sessionId: 'workbench-untrusted', status, detail: `HTTP ${status}` })
    if (isMutation(event)) await recordTransportRefusal(actions, { tool: workbenchTransportTool(event), workspaceId: NODE_WORKSPACE, status })
  },
  named: 'workbench_auth_rejected',
}

/**
 * The grant of one workbench in the addressed workspace, which the workspace's agent tokens do not
 * open. The grant is checked before anything about the workspace is told: an unknown or disabled
 * workspace and a wrong grant are the same 401 (review L6 of B15-B17), and a disabled workspace
 * answers its 409 to the grant holder only, from the route.
 */
export const requireWorkbench: Guard = async (event) => {
  const workspaceId = targetId(event)
  const workbenchId = getRouterParam(event, 'workbenchId', { decode: true }) ?? ''
  const workspaces = await useServices(event).getWorkspaces()
  await checkCredential(event, { verify: async () => (await workspaces.authenticateWorkbench(workspaceId, workbenchId, authorization(event))) || null, refusal: WORKBENCH_REFUSED })
  return { actor: `workbench:${workbenchId}`, workspaceId }
}

export function workbenchTransportTool(event: H3Event): string {
  return `http_workbench_${event.req.method.toLowerCase()}`
}

/** A refusal stands whether or not its entry can be written (B19): no failure to record it turns it into a 500 (review L7 of B20-B22). */
async function audit(event: H3Event, refusal: RefusalAudit | undefined, input: { status: number; registryReadable: boolean }): Promise<void> {
  try {
    await auditRefusal(event, refusal, input)
  } catch (error) {
    event.context.logger?.error('Refused without an audit entry', { route: event.context.matchedRoute?.route, status: input.status, error })
  }
}

async function auditRefusal(event: H3Event, refusal: RefusalAudit | undefined, input: { status: number; registryReadable: boolean }): Promise<void> {
  if (!refusal) return
  const actions = tolerantLog(event, await nodeActions(event))
  if (!namedWorkspace(event)) return refusal.node({ event, actions, status: input.status })
  const workspaceId = targetId(event)
  const known = input.registryReadable && await knownWorkspace(event, workspaceId)
  // Refused before anyone was authenticated, the registry's 503 included.
  await recordRefusal(actions, { tool: refusal.named, workspaceId: known ? workspaceId : UNRESOLVED, sessionId: 'http-untrusted', status: input.status, outcome: 'denied', detail: `HTTP ${input.status}` })
}

async function knownWorkspace(event: H3Event, workspaceId: string): Promise<boolean> {
  try {
    return (await useServices(event).getWorkspaces()).known(workspaceId)
  } catch {
    return false
  }
}
