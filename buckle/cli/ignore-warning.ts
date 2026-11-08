import type { OwnerRecordError } from '../common/adapters/action-log/file-action-log.js'
import { IGNORE_WARNING_FLAG } from '../common/domain/global-flags.js'
import { RECORD_FAILED_EXIT } from './exit-codes.js'
import type { CliResult } from './main.js'

/** The owner's command stopped before it ran (APPROVAL-16): what failed, the write's own error, and how to run it anyway. */
export function stoppedForRecord(error: OwnerRecordError): CliResult {
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
  process.stderr.write(`${error.message}: ${cause}\nRepair the audit log's storage, or run the command again with ${IGNORE_WARNING_FLAG} to run it anyway; Buckle then still tries to write its record in the background.\n`)
  return { exitCode: RECORD_FAILED_EXIT }
}

/** A command the flag does not reach: a tool call never runs without its own record, and serve, mcp, and cp make no owner's change. */
export function ignoreWarningRefused(command: string): string {
  return `${IGNORE_WARNING_FLAG} runs an owner's command whose record the audit log cannot take; buckle ${command} is not one, and a tool call never runs without its own record`
}
