import { isShellWrapper, parseArgv, shownCommand } from '../../argv.js'
import { allForms, commandFormsOf, readLimitOf } from '../../command-forms.js'
import type { CompiledPolicy } from '../../policy.js'
import type { PermissionRule } from '../decision.js'
import { deny } from '../decision.js'

/**
 * `buckle approve`, `buckle policy` and friends administer the node. A tool that could run them
 * would approve its own calls, so they are refused whatever the owner's patterns say. `approvals`
 * is named apart from `approve`: reading the pending queue is how a tool would learn the token
 * it needs to approve itself.
 *
 * The binary is matched by its basename, so a path to it (`/usr/local/bin/buckle`,
 * `./node_modules/.bin/buckle`, or one handed to `node`) and a quoted one in a script body are
 * refused the same way. The subcommand must end the word, so `mcp-probe` or `policy.json` after a
 * directory named `buckle` is not taken for one. This is a speed bump: the real guard is the hidden
 * state directory and the sandbox.
 *
 * It is matched once on the whole command line, a shell's separators counting as word boundaries, which meets
 * every statement and every piece of a script body the old per-statement match met, without splitting the body
 * again on each check (slice 7b review W7B-1).
 */
const SELF_ADMINISTRATION = /(^|[\s/\\'";&|()`])buckle['"]?\s+(approvals|approve|check-url|grants|policy|init|settings|plugin|serve|mcp|workspaces?|history)(?=$|[\s'";&|()`])/

/**
 * The owner's command globs, judged one shell word at a time on the parsed command line. Deny
 * wins, then an allow list, when one exists, admits only what it names. A refusal here is a
 * denial rather than a question: the owner already answered. The destructive-command gate still
 * runs afterwards, so an allowed `rm -rf build` asks before it deletes.
 *
 * A shell wrapper is the exception to needing no allow list: `bash -c` carries a script body
 * rather than argv, so the globs cannot read what it runs and the wrapper itself has to be
 * named before it runs at all.
 *
 * The deny list and the wrapper requirement also meet the command behind a prefix such as `env` or
 * `timeout 5` (the continuation review, "Seen outside this range"). The allow list admits only the call as
 * typed, so a prefix never carries a command past it; the refusal names the raw argv (owner decision D17).
 * A call Buckle cannot read whole, nested past MAX_DEPTH or past READ_BUDGET, is refused whenever a deny glob
 * exists, the limit named, since the glob might have met the part left unread.
 */
export function createCommandPolicyRule(policy: Pick<CompiledPolicy, 'commands'>, options: { enforceWrapperAllow?: boolean } = {}): PermissionRule {
  return {
    id: 'command_policy',
    evaluate({ effect }) {
      if (effect.kind !== 'exec') return null
      const argv = parseArgv(effect.command, effect.args)
      const words = [argv.command, ...effect.args]
      const forms = commandFormsOf(effect)
      // What the refusal names, as an approval shows a command: whole, quoted and redacted (owner decision D17).
      // Written only for a refusal, so a call the policy admits is not redacted on every check (slice 7b review W7B-1).
      const subject = () => shownCommand(effect.command, effect.args)

      if (SELF_ADMINISTRATION.test(words.join(' '))) return deny('command_policy', subject(), 'A tool cannot administer the Buckle that runs it')

      const denied = policy.commands.deny.find(glob => allForms(forms).some(form => glob.matchesPrefix(form)))
      if (denied) return deny('command_policy', subject(), `Refused by the workspace command policy: ${denied.source}`)
      // What was not read cannot be matched, so a deny list refuses it rather than leave the floor's ask to an
      // approval or the dangerously-allow switch (slice 7c review R7C-CR-1; owner decision D7, default D30).
      const limit = policy.commands.deny.length > 0 ? readLimitOf(forms) : null
      if (limit) return deny('command_policy', subject(), `${limit}, so the workspace command policy's deny list cannot meet all of it; refused rather than asked`)

      const allow = policy.commands.allow
      const admitted = allow.some(glob => glob.matchesLine(words))
      const wrapper = forms.chain.find(([command = '', ...args]) => isShellWrapper(parseArgv(command, args)))
      if (options.enforceWrapperAllow !== false && wrapper && !admitted) {
        return deny('command_policy', subject(), `A shell wrapper hides its command from the word globs, so it needs an allow rule of its own: buckle policy allow-command '${wrapper[0]} -c *'`)
      }
      if (allow.length > 0 && !admitted) {
        return deny('command_policy', subject(), `Not on the workspace command allow list. Allowed: ${allow.map(glob => glob.source).join('  |  ')}`)
      }
      return null
    },
  }
}
