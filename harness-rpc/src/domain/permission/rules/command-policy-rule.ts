import { isShellWrapper, parseArgv, shellStatements, statementWords } from '../../argv.js'
import type { CommandGlob } from '../../command-glob.js'
import type { CompiledPolicy } from '../../policy.js'
import type { PermissionRule } from '../decision.js'
import { deny } from '../decision.js'

const MAX_SUBJECT_LENGTH = 300

/**
 * `buckle approve`, `buckle policy` and friends administer the node. A tool that could run them
 * would approve its own calls, so they are refused whatever the owner's patterns say. `approvals`
 * is named apart from `approve`: reading the pending queue is how a tool would learn the token
 * it needs to approve itself.
 */
const SELF_ADMINISTRATION = /(^|\s)buckle\s+(approvals|approve|check-url|grants|policy|init|plugin|serve|mcp|workspaces?|history)\b/

/**
 * The owner's command globs, judged one shell word at a time on the parsed command line. Deny
 * wins, then an allow list, when one exists, admits only what it names. A refusal here is a
 * denial rather than a question: the owner already answered. The destructive-command gate still
 * runs afterwards, so an allowed `rm -rf build` asks before it deletes.
 *
 * A shell wrapper is the exception to needing no allow list: `bash -c` carries a script body
 * rather than argv, so the globs cannot read what it runs and the wrapper itself has to be
 * named before it runs at all.
 */
export function createCommandPolicyRule(policy: Pick<CompiledPolicy, 'commands'>, options: { enforceWrapperAllow?: boolean } = {}): PermissionRule {
  return {
    id: 'command_policy',
    evaluate({ effect }) {
      if (effect.kind !== 'exec') return null
      const argv = parseArgv(effect.command, effect.args)
      const words = [argv.command, ...effect.args]
      const line = words.join(' ')
      const statements = shellStatements(argv)
      const subject = truncate(line)

      if ([line, ...statements].some(candidate => SELF_ADMINISTRATION.test(candidate))) {
        return deny('command_policy', subject, 'A tool cannot administer the Buckle that runs it')
      }

      const denied = findDenied({ globs: policy.commands.deny, words, statements })
      if (denied) return deny('command_policy', subject, `Refused by the workspace command policy: ${denied.source}`)

      const allow = policy.commands.allow
      const admitted = allow.some(glob => glob.matchesLine(words))
      if (options.enforceWrapperAllow !== false && isShellWrapper(argv) && !admitted) {
        return deny('command_policy', subject, `A shell wrapper hides its command from the word globs, so it needs an allow rule of its own: buckle policy allow-command '${argv.command} -c *'`)
      }
      if (allow.length > 0 && !admitted) {
        return deny('command_policy', subject, `Not on the workspace command allow list. Allowed: ${allow.map(glob => glob.source).join('  |  ')}`)
      }
      return null
    },
  }
}

/** A deny glob meets the line and every statement of a script body, so a wrapper hides nothing. */
function findDenied(input: { globs: CommandGlob[]; words: string[]; statements: string[] }): CommandGlob | null {
  const statements = input.statements.map(statementWords)
  return input.globs.find(glob => glob.matchesPrefix(input.words) || statements.some(statement => glob.matchesPrefix(statement))) ?? null
}

function truncate(line: string): string {
  return line.length > MAX_SUBJECT_LENGTH ? `${line.slice(0, MAX_SUBJECT_LENGTH)}…` : line
}
