import { isShellWrapper, parseArgv, shownCommand } from '../../argv.js'
import type { CommandForms } from '../../command-forms.js'
import { commandFormsOf, judgedForms, meetsPrefix, readLimitOf, readLimitReason } from '../../command-forms.js'
import { type CommandGlob, meetsAsSpelled, splitByCommandWord } from '../../command-glob.js'
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
 * `./node_modules/.bin/buckle`, or one handed to `node`), the installed entry point handed to `node`
 * (`.../@5straps/buckle/dist/main.js`), and a quoted one in a script body are refused the same way,
 * with any option words before the subcommand, quoted or not, as `--skip-owner-only-check` may stand there
 * (finding 35 of the workspace-model Phase 1 review, and its recheck). The subcommand must end the word, so
 * `mcp-probe` or `policy.json` after a directory named `buckle` is not taken for one. This is a speed
 * bump: the real guard is the hidden state directory and the sandbox. A quoted subcommand word
 * (`buckle 'keys'`) passes it, a limit that needs an owner allow of the shell wrapper first.
 *
 * It is matched once on the whole command line, a shell's separators counting as word boundaries, which meets
 * every statement and every piece of a script body the old per-statement match met, without splitting the body
 * again on each check (slice 7b review W7B-1).
 *
 * It is read by a scan, not one regular expression: an option word may hold a `/`, so a `-x/buckle` word starts
 * the name again, and a pattern trying every start over the rest of the line took quadratic time, which one crafted
 * call held the node's single thread with (fix brief 4, finding 11). The scan takes each word with a pattern that has
 * no nested repetition, and a position whose words it already read to no subcommand is not read again, so each
 * character is read a bounded number of times.
 */
const ADMINISTERED = 'buckle'
/** What may stand before the binary's name: the line's start, a path separator, a quote, or a shell separator. */
const NAME_BOUNDARY = /[\s/\\'";&|()`]/
/** The rest of the name: the installed entry point's path, and a closing quote. */
const NAME_TAIL = /(?:[/\\]dist[/\\]main\.js)?['"]?/y
const SPACE = /\s+/y
/** One option word before the subcommand, quoted or not, such as `--skip-owner-only-check`. */
const OPTION_WORD = /['"]?-[^\s'";&|()`]*['"]?/y
const ADMIN_VERB = /(?:approvals|approve|check-url|grants|policy|init|settings|plugin|serve|mcp|workspaces?|history|keys|client|service)(?=$|[\s'";&|()`])/y

/** Where `pattern`, anchored at `at`, ends, or null where it does not match there. */
function endOf(pattern: RegExp, line: string, at: number): number | null {
  pattern.lastIndex = at
  return pattern.test(line) ? pattern.lastIndex : null
}

/** Whether the line runs `buckle <subcommand>` for a subcommand that administers the node, read in linear time. */
export function administersBuckle(line: string): boolean {
  // Positions after the name from which the words were read to no subcommand: the same words read again end the same.
  const readToNothing = new Set<number>()
  for (let at = line.indexOf(ADMINISTERED); at !== -1; at = line.indexOf(ADMINISTERED, at + 1)) {
    if (at > 0 && !NAME_BOUNDARY.test(line.charAt(at - 1))) continue
    let position = endOf(NAME_TAIL, line, at + ADMINISTERED.length) ?? at + ADMINISTERED.length
    const read: number[] = []
    while (!readToNothing.has(position)) {
      read.push(position)
      const word = endOf(SPACE, line, position)
      if (word === null) break
      if (endOf(ADMIN_VERB, line, word) !== null) return true
      const option = endOf(OPTION_WORD, line, word)
      if (option === null) break
      position = option
    }
    for (const position of read) readToNothing.add(position)
  }
  return false
}

/**
 * The service manager's programs, by basename, with `.exe` or not and in any case, as Windows reads them, each a word of
 * its own: what starts, stops, or rewrites the unit, agent, or task that runs Buckle at login (fix brief 6, item 8, and
 * the macOS launchd agent of 2026-10-17).
 */
const SERVICE_PROGRAM = /(?:^|[\s/\\'"`(])(?:systemctl|loginctl|launchctl|schtasks)(?:\.exe)?(?=$|[\s'"`)])/i
/**
 * Buckle's unit, as a word of its own (systemctl reads a bare `buckle` as `buckle.service`), its task by name, or its
 * launchd agent's label, alone, at the end of a service target such as `gui/501/com.5straps.buckle`, or as the name of
 * its property list.
 */
const SERVICE_TARGET = /(?:^|[\s'"=])buckle(?:\.service)?(?=$|[\s'"])|5straps[\\/]+buckle(?![\w.-])|(?:^|[\s'"=/])com\.5straps\.buckle(?:\.plist)?(?=$|[\s'"])/i
/** A reload of the user manager, which takes up a changed unit or drop-in. */
const DAEMON_RELOAD = /(?:^|[\s'"])daemon-reload(?=$|[\s'"])/
const USER_MANAGER = /(?:^|[\s'"])--user(?=$|[\s'"])/
/** What ends one statement of a command line, so a target in the next is not read as this program's. */
const STATEMENT_END = /[;&|\n`()]/
/**
 * A command substitution with no parenthesis or backquote inside, such as the `$(id -u)` of `gui/$(id -u)/...`: read
 * also as one word, so it does not cut the statement around it in two.
 */
const SIMPLE_SUBSTITUTION = /\$\([^()`]*\)|`[^()`]*`/g

/**
 * Whether the line runs `systemctl`, `loginctl`, `launchctl`, or `schtasks.exe` on Buckle's own unit, agent, or task, or
 * reloads the user manager (fix brief 6, item 8): a tool that could would stop the node, or start a rewritten one,
 * outside its approvals.
 * Read statement by statement, as written and with each simple command substitution read as a word, each with
 * patterns that hold no nested repetition, so in linear time. A speed bump, as the name match above is: an unsandboxed
 * shell reaches the service manager by other means (known-limits-05).
 */
export function administersBuckleService(line: string): boolean {
  return [line, line.replace(SIMPLE_SUBSTITUTION, 'x')].some(text => text.split(STATEMENT_END).some(statement => SERVICE_PROGRAM.test(statement)
    && (SERVICE_TARGET.test(statement) || (DAEMON_RELOAD.test(statement) && USER_MANAGER.test(statement)))))
}

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
 * limit that stopped the reading, since the glob might have met the part left unread (docs/dev/architecture.md,
 * Interpreters). The node's deny lists are folded into the workspace's in force, a floor over every workspace (D85, Q14;
 * resolveSettings), so every refusal here names the workspace's policy in force.
 *
 * A command word written as a path (D74, bare words only): a deny glob meets it by its basename and as written, and an
 * allow glob that spells the path admits it as written. One that names only the bare word refuses it no more than
 * before, and admits it no longer: the destructive floor asks (createDestructiveCommandRule).
 */
export function createCommandPolicyRule(policy: Pick<CompiledPolicy, 'commands'>, options: { enforceWrapperAllow?: boolean } = {}): PermissionRule {
  const source = 'workspace'
  return {
    id: 'command_policy',
    evaluate({ effect }) {
      if (effect.kind !== 'exec') return null
      const argv = parseArgv(effect.command, effect.args)
      const words = [argv.command, ...effect.args]
      const typed = [effect.command, ...effect.args]
      const forms = commandFormsOf(effect)
      // What the refusal names, as an approval shows a command: whole, quoted and redacted (owner decision D17).
      // Written only for a refusal, so a call the policy admits is not redacted on every check (slice 7b review W7B-1).
      const subject = () => shownCommand(effect.command, effect.args)

      const line = words.join(' ')
      if (administersBuckle(line) || administersBuckleService(line)) return deny('command_policy', subject(), 'A tool cannot administer the Buckle that runs it')

      const denied = deniedBy(policy, forms)
      if (denied) return deny('command_policy', subject(), `Refused by the ${source} command policy: ${denied.source}`)
      // What was not read cannot be matched, so a deny list refuses it rather than leave the floor's ask to an
      // approval or the dangerously-allow switch (slice 7c review R7C-CR-1; owner decision D7, default D30).
      const allowed = policy.commands.allowedInterpreters
      const limit = policy.commands.deny.length > 0 ? readLimitOf(forms, allowed) : null
      if (limit) {
        return deny('command_policy', subject(), `${readLimitReason(limit, forms, allowed)}, so the ${source} command policy's deny list cannot meet all of it; refused rather than asked`)
      }

      const allow = policy.commands.allow
      // A glob's bare alternatives meet the command by its basename, and only its path alternatives meet it as typed (D74).
      const admitted = allow.some(glob => {
        const split = splitByCommandWord(glob)
        return (split.bare?.matchesLine(words) ?? false) || meetsAsSpelled(split.path, typed)
      })
      const wrapper = forms.chain.find(([command = '', ...args]) => isShellWrapper(parseArgv(command, args)))
      if (options.enforceWrapperAllow !== false && wrapper && !admitted) {
        return deny('command_policy', subject(), `A shell wrapper hides its command from the word globs, so it needs an allow rule of its own: buckle policy allow-command '${wrapperRule(typed, wrapper)}'`)
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
 * included (`sudo bash -c *`), and a command word written as a path as written (`/bin/sh -c *`; D74). The shell's
 * words from that `-c` on must end the call as typed; where they do not (an `env -S` value), the rule is the whole call.
 * Each word is written as a pattern word (patternWord).
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

/**
 * The first deny glob of a policy that meets a form of the call, by its basename or as written (D74), read as far as it
 * was read, a command a substitution cut read whole among them (judgedForms; fix brief 7, A3b).
 */
function deniedBy(policy: Pick<CompiledPolicy, 'commands'>, forms: CommandForms): CommandGlob | undefined {
  const judged = judgedForms(forms)
  return policy.commands.deny.find(glob => judged.some(form => meetsPrefix(glob, form)))
}

