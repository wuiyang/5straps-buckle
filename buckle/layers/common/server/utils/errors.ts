import { HTTPError } from 'h3'
import type { AGENT_READABLE_CODES } from '../../../../common/services/agent-failure.js'
import type { STATE_BUSY_MESSAGE } from '../../../../common/services/state-busy.js'
import type { WORKSPACE_REGISTRY_UNREADABLE } from '../../../../common/services/workspaces/workspace-manager.js'
import type { ServiceFailure } from '../../../../common/types/service-failure.js'
import type { OWNER_RECORD_UNAVAILABLE, OwnerRecordError } from '../../../../common/adapters/action-log/file-action-log.js'

// Checked against the common constants at compile time; the layers take common code as types only.
const REGISTRY_UNREADABLE: typeof WORKSPACE_REGISTRY_UNREADABLE = 'WORKSPACE_REGISTRY_UNREADABLE'
const STATE_BUSY_TEXT: typeof STATE_BUSY_MESSAGE = 'Buckle state is busy in another process; retry shortly'
const OWNER_RECORD: typeof OWNER_RECORD_UNAVAILABLE = 'OWNER_RECORD_UNAVAILABLE'
/** How a setup request makes the change its record could not be written for. */
const OWNER_RECORD_BYPASS = 'repair the audit log\'s storage, or send the request again with ignoreWarning=true in its query to make the change anyway; its record is then still tried in the background'
const AGENT_READABLE = Object.freeze<Record<(typeof AGENT_READABLE_CODES)[number], true>>({ WORKSPACE_REFUSED: true, WORKBENCH_REFUSED: true, AUDIT_UNAVAILABLE: true })

/** A common error that carries its code and HTTP status (common/types/service-failure.ts). */
export function isServiceFailure(error: unknown): error is ServiceFailure {
  const fields = error as Partial<ServiceFailure> | null
  return error instanceof Error && !HTTPError.isError(error) && typeof fields?.code === 'string' && typeof fields.status === 'number'
}

export function hasCode(error: unknown, code: string): boolean {
  return isServiceFailure(error) && error.code === code
}

/**
 * The HTTP error a failure answers with on the owner's routes: an HTTPError as it is, a service
 * failure by its own status and message, and nothing else, which the error handler answers as an
 * unhandled 500 and logs.
 */
export function toHttpError(error: unknown): unknown {
  if (!isServiceFailure(error)) return error
  if (error.code === OWNER_RECORD) return ownerRecordHttpError(error as OwnerRecordError)
  return new HTTPError({ status: error.status, statusText: statusText(error.status), message: error.message })
}

/** An owner's change its record stopped: how to make it anyway, its code for a client to say so, and the write's error with no path. */
function ownerRecordHttpError(error: OwnerRecordError): HTTPError {
  return new HTTPError({ status: error.status, statusText: statusText(error.status), message: `${error.message}; ${OWNER_RECORD_BYPASS}`, body: { code: OWNER_RECORD, recordError: error.reason } })
}

/** Runs a service call on an owner's route, answering its failures by their status (plan section B: explicit error mapping). */
export async function mapFailures<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toHttpError(error)
  }
}

/**
 * The HTTP error a failure answers with where an agent reads it (agent credential, workbench grant,
 * MCP): only codes whose messages never name a path keep their own; busy state, an unreadable
 * registry and a stored policy that will not load get fixed text, because the state directory is
 * hidden from agents by design; any other failure is an unhandled 500 with its cause in the owner's
 * log only (review M1 of B15-B17).
 */
export function toAgentError(error: unknown): unknown {
  if (!isServiceFailure(error)) return error
  if (Object.hasOwn(AGENT_READABLE, error.code)) return toHttpError(error)
  if (error.code === 'STATE_BUSY') return HTTPError.status(503, 'Service Unavailable', { message: STATE_BUSY_TEXT })
  if (error.code === REGISTRY_UNREADABLE) return registryNeedsRepair()
  if (error.code.startsWith('POLICY_')) return HTTPError.status(409, 'Conflict', { message: 'Workspace policy needs owner repair' })
  return new Error(`A ${error.code} failure is not shown to agents`, { cause: error })
}

/** Runs a service call on an agent-facing route, answering its failures through the agent allowlist. */
export async function mapAgentFailures<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toAgentError(error)
  }
}

/**
 * What a failure before any credential was checked answers: the registry's own 503, and 401 for
 * anything else, so an unauthenticated caller cannot tell a broken workspace from a wrong credential
 * (review M1 of B15-B17, L1 of B18-B19). The cause goes to the owner's log only.
 */
export function beforeCredential(error: unknown): HTTPError {
  if (hasCode(error, REGISTRY_UNREADABLE)) return registryNeedsRepair()
  return unauthorized()
}

/** Whether a failure before the credential was the registry's own, which says nothing about one workspace. */
export function isRegistryFailure(error: unknown): boolean {
  return hasCode(error, REGISTRY_UNREADABLE)
}

/**
 * Before authentication a caller learns nothing about the registry beyond that it needs repair: a
 * generic 503, audited where the face audits refusals (review M3 of B6-B9).
 */
export function registryNeedsRepair(): HTTPError {
  return HTTPError.status(503, 'Service Unavailable', { message: 'Workspace registry needs owner repair' })
}

export function unauthorized(): HTTPError {
  return HTTPError.status(401, 'Unauthorized')
}

/**
 * A 404 of Buckle's own, whose message may be shown. The router's own 404 carries no status text, and
 * its message echoes the full URL, so the error handler answers that one "Not Found" (server/error.ts).
 */
export function notFound(message = 'Not Found'): HTTPError {
  return HTTPError.status(404, 'Not Found', { message })
}

const STATUS_TEXT: Readonly<Record<number, string>> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Content Too Large', 422: 'Unprocessable Content', 429: 'Too Many Requests', 503: 'Service Unavailable' }

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'Error'
}
