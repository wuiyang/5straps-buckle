import { parseArgv, shellStatements } from '../../argv.js'
import type { CompiledPolicy } from '../../policy.js'
import type { PermissionRule } from '../decision.js'
import { deny } from '../decision.js'

const MAX_SUBJECT_LENGTH = 300

/**
 * `buckle approve`, `buckle policy` and friends administer the node. A tool that could run them
 * would approve its own calls, so they are refused whatever the owner's patterns say.
 */
const SELF_ADMINISTRATION = /(^|\s)buckle\s+(approve|grants|policy|init|plugin|serve|mcp)\b/

/**
 * The owner's command patterns, judged on the parsed command line. Deny wins, then an allow
 * list, when one exists, admits only what it names. A refusal here is a denial rather than a
 * question: the owner already answered. The destructive-command gate still runs afterwards,
 * so an allowed `rm -rf build` asks before it deletes.
 */
export function createCommandPolicyRule(policy: Pick<CompiledPolicy, 'commands'>): PermissionRule {
  return {
    id: 'command_policy',
    evaluate({ effect }) {
      if (effect.kind !== 'exec') return null
      const argv = parseArgv(effect.command, effect.args)
      const line = [argv.command, ...effect.args].join(' ')
      const statements = shellStatements(argv)
      const subject = truncate(line)

      if ([line, ...statements].some(candidate => SELF_ADMINISTRATION.test(candidate))) {
        return deny('command_policy', subject, 'A tool cannot administer the Buckle that runs it')
      }

      const denied = policy.commands.deny.find(pattern => pattern.test(line) || statements.some(statement => pattern.test(statement)))
      if (denied) return deny('command_policy', subject, `Refused by the workspace command policy: ${denied.source}`)

      if (policy.commands.allow.length > 0 && !policy.commands.allow.some(pattern => pattern.test(line))) {
        const allowed = policy.commands.allow.map(pattern => pattern.source).join('  |  ')
        return deny('command_policy', subject, `Not on the workspace command allow list. Allowed: ${allowed}`)
      }
      return null
    },
  }
}

function truncate(line: string): string {
  return line.length > MAX_SUBJECT_LENGTH ? `${line.slice(0, MAX_SUBJECT_LENGTH)}…` : line
}
