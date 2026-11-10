import { OWNER_RECORD_FAILED, OwnerRecordError } from '../common/adapters/action-log/file-action-log.js'
import { IGNORE_WARNING_FLAG } from '../common/domain/global-flags.js'
import { RECORD_FAILED_EXIT } from './exit-codes.js'
import type { CliResult } from './result.js'

/** The owner's command stopped before it ran: what failed, the write's own error, and how to run it anyway. */
export function stoppedForRecord(error: OwnerRecordError): CliResult {
  return stoppedWith(error.cause instanceof Error ? error.cause.message : String(error.cause))
}

/** The same, where a node refused the change for its own record, naming the write's error as it said it. */
export function stoppedForNodeRecord(recordError: string | undefined): CliResult {
  return stoppedWith(recordError ?? 'the node gave no reason')
}

function stoppedWith(cause: string): CliResult {
  process.stderr.write(`${OWNER_RECORD_FAILED}: ${cause}\nRepair the audit log's storage, or run the command again with ${IGNORE_WARNING_FLAG} to run it anyway; Buckle then still tries to write its record in the background.\n`)
  return { exitCode: RECORD_FAILED_EXIT }
}

/** A command the flag does not reach: a tool call never runs without its own record, and serve, mcp, and cp make no owner's change. */
export function ignoreWarningRefused(command: string): string {
  return `${IGNORE_WARNING_FLAG} runs an owner's command whose record the audit log cannot take; buckle ${command} is not one, and a tool call never runs without its own record`
}

/** `ignoreWarning`: the owner's --ignore-warning, which runs a command whose record cannot be written. */
export interface OwnerChoice { ignoreWarning?: boolean }

export async function stopsForRecord(command: Promise<CliResult>): Promise<CliResult> {
  try { return await command } catch (error) {
    if (error instanceof OwnerRecordError) return stoppedForRecord(error)
    throw error
  }
}
