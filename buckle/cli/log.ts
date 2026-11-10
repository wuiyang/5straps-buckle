import { parseArgs } from 'node:util'
import { printable } from '../common/domain/approval-instruction.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CliResult } from './result.js'
import { print } from './output.js'

/** The audit view. Every attempt appears, so a refusal is as visible as a success. */
export function logCommand(runtime: BuckleRuntime, argv: string[]): CliResult {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: false,
  })
  const limit = Number.parseInt(values.limit ?? '50', 10)
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    process.stderr.write('--limit must be a positive integer\n')
    return { exitCode: 1 }
  }

  const entries = runtime.actions.read(limit)
  if (values.json) return print(entries)
  if (entries.length === 0) {
    process.stdout.write('No actions recorded yet.\n')
    return { exitCode: 0 }
  }

  // The tool name, effects, subjects and detail all carry what an agent sent (review L1 of B13-B14, `buckle log`).
  for (const entry of entries) {
    process.stdout.write(`${entry.at}  ${entry.outcome.padEnd(17)} ${printable(entry.tool).padEnd(18)} ${entry.durationMs}ms\n`)
    for (const effect of entry.effects) process.stdout.write(`    ${printable(effect)}\n`)
    for (const ask of entry.asked ?? []) process.stdout.write(`    asked: ${printable(ask)}\n`)
    for (const grant of entry.approvedBy ?? []) process.stdout.write(`    allowed by: ${printable(grant)}\n`)
    // A script's call names the code_run call whose script made it (final review of 0.1.4, finding invoker 701).
    if (entry.parentRequestId) process.stdout.write(`    parent request: ${printable(entry.parentRequestId)}\n`)
    if (entry.detail) process.stdout.write(`    ${printable(entry.detail)}\n`)
  }
  return { exitCode: 0 }
}
