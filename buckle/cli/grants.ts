import type { GrantRecord } from '@5straps/protocol'
import { StateFileError } from '../common/adapters/json-file-store.js'
import { printable } from '../common/domain/approval-instruction.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CliResult } from './result.js'
import { fail } from './output.js'
export { GRANTS_USAGE } from './usage.js'

export async function grantsCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [action, id] = argv
  if (action === 'revoke') {
    if (!id) return fail('Usage: buckle grants revoke <id>')
    if (!await runtime.grants.revoke(id)) return fail(`Grant not found: ${id}`)
    process.stdout.write(`Revoked ${id}\n`)
    return { exitCode: 0 }
  }
  for (const grant of runtime.grants.list()) process.stdout.write(grantLine(grant))
  for (const grant of owedGrants(runtime)) process.stdout.write(grantLine(grant, '  (not saved yet)'))
  return { exitCode: 0 }
}

// A session grant serves one caller in one session, so two callers' grants for one subject are told apart.
function grantLine(grant: GrantRecord, note = ''): string {
  const holder = grant.sessionId === null ? '' : `  (session ${printable(grant.sessionId)}, caller ${grant.actor === null ? 'the node\'s own process' : printable(grant.actor)})`
  return `${grant.id}  ${grant.denied ? 'DENY ' : 'ALLOW'} ${grant.scope.padEnd(8)} ${grant.rule.padEnd(20)} ${printable(grant.subject)}${grant.pattern ? '  (host pattern)' : ''}${holder}${note}\n`
}

/** The approvals decided whose grants are not written yet, which a revoke still takes; none listed where the ledger cannot be read. */
function owedGrants(runtime: BuckleRuntime): GrantRecord[] {
  try {
    return runtime.grants.owed()
  } catch (error) {
    if (!(error instanceof StateFileError)) throw error
    process.stderr.write('The approvals file cannot be read, so approvals whose grants are not written yet are not listed\n')
    return []
  }
}
