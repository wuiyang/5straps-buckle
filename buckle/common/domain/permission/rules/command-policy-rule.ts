import { isShellWrapper, parseArgv, shownCommand } from '../../argv.js'
import type { CommandForms } from '../../command-forms.js'
import { allForms, commandFormsOf, readLimitOf, readLimitReason } from '../../command-forms.js'
import type { CommandGlob } from '../../command-glob.js'
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
 * A call Buckle cannot read whole, past READ_BUDGET, MAX_DEPTH or MAX_SUBSTITUTIONS, at a find -exec command that
 * is a primary, at a script that arrives as data, at shell text an expansion supplies (an eval or a shell -c string),
 * or running code with an interpreter this policy does not allow, is refused whenever a deny glob exists, naming the
 * limit that stopped the reading, since the glob might have met the part left unread (defaults D30 and D33, owner
 * decision D55). Each policy judges interpreters by its own list, so the
 * node ceiling refuses one a workspace allows unless the ceiling allows it too (owner decision D7).
 *
 * `source` names whose policy this is, so a refusal by the node's ceiling says so (slice 7d review R7D-BD-2). `others`
 * are the command policies whose rules run after this one: a glob of theirs that met the parts read is named before
 * this policy's reading limit, so the node ceiling's limit never stands in for the workspace glob that matched (slice
 * 7e review R7E-LW-3). The call is refused either way.
 */
export function createCommandPolicyRule(policy: Pick<CompiledPolicy, 'commands'>, options: { enforceWrapperAllow?: boolean; source?: CommandPolicySource; others?: readonly NamedCommandPolicy[] } = {}): PermissionRule {
  const source = options.source ?? 'workspace'
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

      const denied = deniedBy(policy, forms)
      if (denied) return deny('command_policy', subject(), `Refused by the ${source} command policy: ${denied.source}`)
      // What was not read cannot be matched, so a deny list refuses it rather than leave the floor's ask to an
      // approval or the dangerously-allow switch (slice 7c review R7C-CR-1; owner decision D7, default D30).
      const allowed = policy.commands.allowedInterpreters
      const limit = policy.commands.deny.length > 0 ? readLimitOf(forms, allowed) : null
      if (limit) {
        for (const other of options.others ?? []) {
          const matched = deniedBy(other.policy, forms)
          if (matched) return deny('command_policy', subject(), `Refused by the ${other.source} command policy: ${matched.source}`)
        }
        return deny('command_policy', subject(), `${readLimitReason(limit, forms, allowed)}, so the ${source} command policy's deny list cannot meet all of it; refused rather than asked`)
      }

      const allow = policy.commands.allow
      const admitted = allow.some(glob => glob.matchesLine(words))
      const wrapper = forms.chain.find(([command = '', ...args]) => isShellWrapper(parseArgv(command, args)))
      if (options.enforceWrapperAllow !== false && wrapper && !admitted) {
        return deny('command_policy', subject(), `A shell wrapper hides its command from the word globs, so it needs an allow rule of its own: buckle policy allow-command '${wrapperRule(words, wrapper)}'`)
      }
      if (allow.length > 0 && !admitted) {
        return deny('command_policy', subject(), `Not on the ${source} command allow list. Allowed: ${allow.map(glob => glob.source).join('  |  ')}`)
      }
      return null
    },
  }
}

/**
 * The allow rule a shell wrapper's refusal names, one that admits the call: an allow glob meets the call as typed, so
 * the rule is the call's own words up to the shell's `-c` word, then `*`, a prefix such as `sudo`, `env`, or `nice`
 * included (`sudo bash -c *`). The shell's words from that `-c` on must end the call as typed; where they do not (an
 * `env -S` value), the rule is the whole call. Each word is written as a pattern word (patternWord).
 */
function wrapperRule(typed: readonly string[], shell: readonly string[]): string {
  const flag = shell.findIndex((word, index) => index > 0 && SHORT_OPTIONS.test(word) && word.includes('c'))
  const from = typed.length - (shell.length - flag)
  const ends = flag > 0 && from >= 0 && shell.slice(flag).every((word, index) => typed[from + index] === word)
  return ends ? [...typed.slice(0, from + 1).map(patternWord), '*'].join(' ') : typed.map(patternWord).join(' ')
}

/** A cluster of short options (`-c`, `-lc`), never a long one. */
const SHORT_OPTIONS = /^-[^-]/
/**
 * What a pattern word cannot hold as itself: a blank, which ends a pattern word; a brace, which starts alternatives;
 * regular-expression syntax, which a pattern refuses; and a single quote, which would end the quoted rule a refusal shows.
 */
const UNSPELLABLE = /[\s{}'^$()|\\+?[\]]+/g

/** A typed word as a pattern word that still meets it: each run of characters a pattern cannot hold becomes `*`. */
function patternWord(word: string): string {
  return word.replace(UNSPELLABLE, '*').replace(/\*+/g, '*') || '*'
}

/** The first deny glob of a policy that meets a form of the call, read as far as it was read. */
function deniedBy(policy: Pick<CompiledPolicy, 'commands'>, forms: CommandForms): CommandGlob | undefined {
  return policy.commands.deny.find(glob => allForms(forms).some(form => glob.matchesPrefix(form)))
}

/** Whose command policy a rule applies: a workspace's own, or the node's ceiling over every registered workspace. */
export type CommandPolicySource = 'workspace' | 'node ceiling'

/** A command policy with the name its refusals give it. */
export interface NamedCommandPolicy { policy: Pick<CompiledPolicy, 'commands'>; source: CommandPolicySource }
