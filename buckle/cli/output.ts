import { WorkspaceError } from '../common/domain/workspace-error.js'
import type { CliResult } from './result.js'

export function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

export function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}

/** A named workspace that is unknown, disabled or retired is a typo to report, not a crash. */
export async function reportWorkspaceErrors(operation: () => Promise<CliResult>): Promise<CliResult> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  }
}
