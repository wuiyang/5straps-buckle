import type { ServiceFailure } from '../types/service-failure.js'
import { isStateBusy, STATE_BUSY_MESSAGE } from './state-busy.js'

/** Codes whose messages never name a path or a state file, so an agent may read them as they are. */
export const AGENT_READABLE_CODES = ['WORKSPACE_REFUSED', 'WORKBENCH_REFUSED', 'AUDIT_UNAVAILABLE'] as const

/** What a failure that escaped the invoker tells an agent when nothing more specific applies. */
export const TOOL_CALL_FAILED = 'Tool invocation failed'

/**
 * What an agent reads about a failure that escaped the invoker, such as an MCP tool call whose audit
 * or approval state could not be written: never a path, because the state directory is hidden from
 * agents by design (review M1 of B15-B17). The HTTP faces apply the same allowlist by status
 * (layers/common/server/utils/errors.ts).
 */
export function agentFailureMessage(error: unknown): string {
  if (isStateBusy(error)) return STATE_BUSY_MESSAGE
  const failure = error as Partial<ServiceFailure> | null
  if (error instanceof Error && (AGENT_READABLE_CODES as readonly unknown[]).includes(failure?.code)) return error.message
  return TOOL_CALL_FAILED
}
