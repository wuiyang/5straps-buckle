import { getRouterParam, HTTPError, type H3Event } from 'h3'
import type { Guard } from '@5straps/runtime/nitro'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import type { WORKSPACE_REGISTRY_UNREADABLE } from '../../../../common/services/workspaces/workspace-manager.js'
import { nodeActions, recordRefusal, recordTransportRefusal } from './audit.js'
import { hasCode, mapFailures, toHttpError, unauthorized } from './errors.js'
import { useServices } from './services.js'
import { namedWorkspace, targetId } from './target.js'

// Checked against the common constant at compile time; the layers take common code as types only.
const REGISTRY_UNREADABLE: typeof WORKSPACE_REGISTRY_UNREADABLE = 'WORKSPACE_REGISTRY_UNREADABLE'
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
 * Before authentication a caller learns nothing about the registry beyond that it needs repair: a
 * generic 503, audited where the face audits refusals (review M3 of B6-B9).
 */
export function registryNeedsRepair(): HTTPError {
  return HTTPError.status(503, 'Service Unavailable', { message: 'Workspace registry needs owner repair' })
}

/**
 * Runs one credential check for the addressed workspace: 503 when the registry cannot be read, 401
 * when the check fails, each audited through the face's refusal audit, and what the check returned
 * otherwise. Every guard of every layer goes through this, so none can skip the audit.
 */
export async function checkCredential<T>(event: H3Event, input: { verify: () => T | null; refusal?: RefusalAudit }): Promise<T> {
  let verified: T | null
  try {
    verified = input.verify()
  } catch (error) {
    if (!hasCode(error, REGISTRY_UNREADABLE)) throw error
    await audit(event, input.refusal, 503)
    throw registryNeedsRepair()
  }
  if (verified === null) {
    await audit(event, input.refusal, 401)
    throw unauthorized()
  }
  return verified
}

/**
 * The agent credential of the addressed workspace: one of its agent tokens, read per request so a
 * revoked token is refused at once. The actor is the token's id under its credential kind.
 */
export function requireAgent(refusal?: RefusalAudit): Guard {
  return async (event) => {
    const workspaceId = targetId(event)
    const workspaces = await useServices(event).getWorkspaces()
    const tokenId = await checkCredential(event, { verify: () => workspaces.authenticateAgent(workspaceId, authorization(event)), ...(refusal ? { refusal } : {}) })
    return { actor: `agent:${tokenId}`, workspaceId }
  }
}

/**
 * The grant of one workbench in the addressed workspace, which the workspace's agent tokens do not
 * open. The workspace resolves first, as before the move: 404 or 409 before 401.
 */
export const requireWorkbench: Guard = async (event) => {
  const workbenchId = getRouterParam(event, 'workbenchId', { decode: true }) ?? ''
  const workspaces = await useServices(event).getWorkspaces()
  const { runtime } = await workspaces.resolve(targetId(event)).catch((error: unknown) => {
    throw hasCode(error, REGISTRY_UNREADABLE) ? registryNeedsRepair() : toHttpError(error)
  })
  if (!await mapFailures(() => runtime.workbenches.authenticate(workbenchId, authorization(event)))) {
    await runtime.workbenches.auditRejected()
    // At node level a workbench's transport audit took in its credential check too.
    if (!namedWorkspace(event) && isMutation(event)) await recordTransportRefusal(runtime.actions, { tool: workbenchTransportTool(event), workspaceId: runtime.workspaceId, status: 401 })
    throw unauthorized()
  }
  return { actor: `workbench:${workbenchId}`, workspaceId: targetId(event) }
}

export function workbenchTransportTool(event: H3Event): string {
  return `http_workbench_${event.req.method.toLowerCase()}`
}

async function audit(event: H3Event, refusal: RefusalAudit | undefined, status: number): Promise<void> {
  if (!refusal) return
  const actions = await nodeActions(event)
  if (!namedWorkspace(event)) return refusal.node({ event, actions, status })
  const workspaceId = targetId(event)
  const known = status !== 503 && await knownWorkspace(event, workspaceId)
  // Refused before anyone was authenticated, the registry's 503 included.
  await recordRefusal(actions, { tool: refusal.named, workspaceId: known ? workspaceId : UNRESOLVED, sessionId: 'http-untrusted', status, outcome: 'denied', detail: `HTTP ${status}` })
}

async function knownWorkspace(event: H3Event, workspaceId: string): Promise<boolean> {
  try {
    return (await useServices(event).getWorkspaces()).known(workspaceId)
  } catch {
    return false
  }
}
