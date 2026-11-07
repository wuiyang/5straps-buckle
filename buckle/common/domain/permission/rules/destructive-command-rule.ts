import type { ParsedArgv } from '../../argv.js'
import { commandSubject, gitInvocation, hasFlag, parseArgv, parseGitSubcommand, SHELL_COMMANDS } from '../../argv.js'
import { type CommandGlob, meetsAsSpelled, splitByCommandWord } from '../../command-glob.js'
import { type CommandForms, commandFormsOf, judgedForms, meetsPrefix, readLimitOf, readLimitReason, typedForm } from '../../command-forms.js'
import type { AskCause, PermissionRule } from '../decision.js'
import { allowedVia, ask, commandMarks } from '../decision.js'

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'pkexec'])
const DISK_COMMANDS = new Set(['mkfs', 'fdisk', 'parted', 'wipefs', 'blkdiscard', 'shred', 'sgdisk'])

/**
 * Why a call asks that runs a command written as a path only a bare-word allow rule names (D74): constant, the call shown
 * whole. Its hint holds on every platform: no rule names a spelling not written plainly, nor, on Linux and macOS, one
 * written with a backslash (git pack recheck 1, held[4]).
 */
export const PATH_SPELLING_REASON = 'A command written as a path runs the program at that path, which an allow rule naming the bare command does not admit; asked rather than run (a path written plainly with slashes can be named by an allow rule that spells it)'

/**
 * A target word that stands for more than one file, or for one Buckle cannot see: a glob character, a brace group of
 * choices or a range (`{a,b}.txt`, `{1..9}`), a variable or a command substitution (`$FILES`, `$(ls)`, a backtick), and
 * the `{}` that find -exec fills with each file it finds.
 */
const SEVERAL_TARGETS = /[*?[$`]|\{[^{}]*(?:,|\.\.)[^{}]*\}|^\{\}$/

/** Shell text is not argv, so these run against the script body of `bash -c`. */
const SCRIPT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\|\s*(sudo\s+)?(ba|z|k)?sh\b/, reason: 'Pipes a downloaded payload into a shell' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb' },
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/(?:\s|$)/, reason: 'Recursive delete from the filesystem root' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/, reason: 'Writes directly to a block device' },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: 'Formats a filesystem' },
  { pattern: /\bdd\b[^\n]*\bof=/, reason: 'Raw device or file overwrite via dd' },
  { pattern: /\bchmod\s+(-[a-z]*r[a-z]*\s+)*777\b/, reason: 'Grants world-writable permissions' },
]

/**
 * The built-in list is a floor. `added` holds the globs the owner raised it with for this
 * workspace, which widen what asks and can never narrow it.
 *
 * Every command the call runs is judged: the call as typed, the command behind a wrapper prefix such as `env`,
 * `nice`, `timeout 5`, `xargs` or a NAME=value assignment, each statement of a shell body or of eval's text, and
 * each find -exec command (the continuation review, "Seen outside this range"; slice 7 review F1; owner decision
 * D25). A call Buckle cannot read whole asks, naming the limit that stopped the reading (READ_LIMITS; slice 7b review
 * W7B-1), an eval or a shell -c string whose text an expansion supplies among them, and a call running code with an
 * interpreter the workspace does not allow (`allowedInterpreters`; docs/developer/architecture.md, Interpreters); with a
 * command deny list, the
 * command policy refuses such a call first (slice 7c review R7C-CR-1). The subject asked and granted stays the call's
 * own argv (owner decision D17).
 *
 * `allow`, the workspace's command allow list: a command the call runs written as a path that only a glob naming its
 * bare word meets asks here, as a floor reason (D74, bare words only); the command policy no longer admits it by that
 * glob, and no longer refuses it either. `platform`: the host's unless a test imitates another (meetsAsSpelled).
 */
export function createDestructiveCommandRule(input: { added?: readonly CommandGlob[]; allowedInterpreters?: ReadonlySet<string>; allow?: readonly CommandGlob[]; platform?: NodeJS.Platform } = {}): PermissionRule {
  const added = input.added ?? []
  const platform = input.platform ?? process.platform
  // Each allow glob by the alternatives of its command word: `{git,/usr/bin/git} status` names the bare word and spells a path.
  const splits = (input.allow ?? []).map(splitByCommandWord)
  const bareAllow = splits.flatMap(split => (split.bare ? [split.bare] : []))
  const pathAllow = splits.flatMap(split => (split.path ? [split.path] : []))
  const allowed = input.allowedInterpreters
  return {
    id: 'destructive_command',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'exec') return null
      const forms = commandFormsOf(effect)
      const limit = readLimitOf(forms, allowed)
      // A command a substitution cut is judged whole too, as its head shows it (judgedForms), and the script patterns read
      // its words, so `chmod>$(echo)x 777 x` asks as `chmod 777 x` in a script body does (fix brief 7, A3b).
      const judged = judgedForms(forms)
      const floor = firstReason(judged) ?? headScriptReason(forms.heads)
      const listed = floor === null ? classifyAdded({ added, forms: judged }) : null
      const found = floor ?? (limit ? `${readLimitReason(limit, forms, allowed)}; asked rather than guessed at` : null) ?? listed
      // What the decision AI may answer (D91): an unknown interpreter alone, never a built-in reason, another reading
      // limit, or a call the owner's destructive list names, whichever reason the ask shows.
      const foundCause: AskCause = floor !== null || (limit !== null && limit !== 'interpreter') ? 'floor' : listed !== null ? 'destructive-list' : 'interpreter'
      // A command written as a path that only a bare-word allow rule names asks a person (D74), where the call would
      // otherwise run or its one question would be the interpreter the thorough stage answers.
      const spelled = (found === null || foundCause === 'interpreter') && runsByBareName({ forms, bare: bareAllow, spelled: pathAllow, own: effect.shownAs !== undefined, platform })
      const reason = spelled ? PATH_SPELLING_REASON : found
      if (!reason) return null
      const cause: AskCause = spelled ? 'floor' : foundCause
      // For the dangerously-allow switch: a privilege command among the commands read, or a call read only in part, which may hold one.
      const privileged = runsPrivilegeCommand(judged) || (limit !== null && limit !== 'interpreter')

      // The shown command and its lossless identity (owner decision D17): never joined, never cut, no
      // credential the display redacts; a grant made before this form matches nothing.
      const subject = subjectOf(effect)
      if (grants.subjectsFor('destructive_command').includes(subject)) return allowedVia('destructive_command', subject)
      // No 'always': a standing grant for a destructive signature defeats the gate.
      return ask({ rule: 'destructive_command', subject, reason, marks: commandMarks(cause), offeredScopes: ['once', 'session'], cause, privileged, severity: floor !== null || listed !== null ? 'danger' : 'warn' })
    },
  }
}

const subjects = new WeakMap<object, string>()

/** An effect's subject, written once per effect, since every check of a call asks under the same one (slice 7b review W7B-1). */
function subjectOf(effect: { command: string; args: readonly string[] }): string {
  const known = subjects.get(effect)
  if (known !== undefined) return known
  const subject = commandSubject(effect.command, effect.args)
  subjects.set(effect, subject)
  return subject
}

function runsPrivilegeCommand(forms: readonly string[][]): boolean {
  return forms.some(([command = '', ...args]) => PRIVILEGE_COMMANDS.has(parseArgv(command, args).command))
}

function firstReason(forms: readonly string[][]): string | null {
  // An rm with no target of its own is one only xargs gives its files.
  const fed = forms.some(([command = '', ...args]) => parseArgv(command, args).command === 'xargs')
  for (const [command = '', ...args] of forms) {
    const argv = parseArgv(command, args)
    const reason = classifyArgv(argv, args, fed) ?? classifyShellScript(argv)
    if (reason) return reason
  }
  return null
}

function classifyArgv(argv: ParsedArgv, args: readonly string[], fed: boolean): string | null {
  if (PRIVILEGE_COMMANDS.has(argv.command)) return `${argv.command} escalates privileges`
  if (DISK_COMMANDS.has(argv.command) || argv.command.startsWith('mkfs.')) return `${argv.command} destroys disk contents`

  if (argv.command === 'rm' && hasFlag(argv, 'r', 'recursive') ) return 'Recursive delete'
  if (argv.command === 'rm' && hasFlag(argv, 'f', 'force')) return 'Forced delete'
  // A plain rm of one literal path stays as it was; a glob, a second target, or a word the shell expands into targets
  // deletes what nobody named (the fs-verbs brief), and so does an rm that xargs feeds its targets.
  if (argv.command === 'rm' && (argv.positionals.length >= 2 || (argv.positionals.length === 0 && fed) || argv.positionals.some(target => SEVERAL_TARGETS.test(target)))) return 'Delete of several files'
  if (argv.command === 'dd' && argv.positionals.some(item => item.startsWith('of='))) return 'dd writes over a target'
  if (argv.command === 'truncate') return 'Truncates a file in place'
  if ((argv.command === 'chmod' || argv.command === 'chown') && hasFlag(argv, 'R', 'recursive')) {
    return `Recursive ${argv.command}`
  }
  if (argv.command === 'find' && (argv.longFlags.has('delete') || argv.positionals.includes('-delete'))) {
    return 'find with -delete'
  }
  if (['kill', 'pkill', 'killall'].includes(argv.command) && hasFlag(argv, '9')) return 'Sends SIGKILL'
  if (argv.positionals.some(item => item.startsWith('/dev/'))) return 'Targets a device node'

  return classifyGit(argv, args)
}

/** The subcommand and its flags as git reads them, past git's own options before it (review M6). */
function classifyGit(argv: ParsedArgv, args: readonly string[]): string | null {
  if (argv.command !== 'git') return null
  const invocation = gitInvocation(args)
  if (invocation.doubleDash) return 'git refuses a bare -- before its subcommand; asked rather than guessed at'
  const subcommand = invocation.subcommand?.toLowerCase() ?? null
  const flags = parseGitSubcommand(subcommand, invocation.args)
  if (subcommand === 'push' && hasGitOption(flags, 'f', 'force', 'force-with-lease', 'force-if-includes')) return 'Force push rewrites remote history'
  if (subcommand === 'push' && hasGitOption(flags, 'd', 'delete')) return 'git push --delete deletes remote branches'
  if (subcommand === 'push' && hasGitOption(flags, null, 'mirror')) return 'git push --mirror overwrites and deletes remote refs'
  if (subcommand === 'push' && hasGitOption(flags, null, 'prune')) return 'git push --prune deletes remote branches'
  if (subcommand === 'reset' && hasGitOption(flags, null, 'hard')) return 'git reset --hard discards local work'
  if (subcommand === 'clean' && hasGitOption(flags, 'f', 'force')) return 'git clean deletes untracked files'
  if (subcommand === 'checkout' && hasGitOption(flags, 'f', 'force')) return 'git checkout --force discards local changes'
  return null
}

/**
 * A short flag, or a long option as git reads it: git takes any prefix of a long option's name that no other of the
 * subcommand's options shares (`--forc` is `--force`) and refuses a shared one, so a typed name that begins one of
 * these is read as it, the dangerous reading of an ambiguous prefix (the `--forc` item of the slice 5 re-review).
 */
function hasGitOption(flags: ParsedArgv, short: string | null, ...names: string[]): boolean {
  if (short && flags.shortFlags.has(short)) return true
  return [...flags.longFlags.keys()].some(typed => typed.length > 0 && names.some(name => name.startsWith(typed)))
}

/**
 * Whether the call runs a command written as a path that a glob naming its bare word meets and no glob spelling a path
 * admits as written (D74), in the call as typed or any command it runs: a shell body's `./git status` asks as the call
 * `./git status` does, and so does a command a substitution cuts, read whole as its head shows it (judgedForms; fix
 * brief 7, A3b). `own`: the call's own command word is a host path Buckle supplies itself (ExecEffect.shownAs), not a
 * spelling of the agent's.
 */
function runsByBareName(input: { forms: CommandForms; bare: readonly CommandGlob[]; spelled: readonly CommandGlob[]; own: boolean; platform: NodeJS.Platform }): boolean {
  if (input.bare.length === 0) return false
  return judgedForms(input.forms).some(form => {
    const typed = typedForm(form)
    if (typed === form || (input.own && form === input.forms.chain[0])) return false
    return input.bare.some(glob => glob.matchesLine(form)) && !input.spelled.some(glob => meetsAsSpelled(glob, typed, input.platform))
  })
}

/** The first glob of the workspace's destructive list that meets a form, by its basename or as written (D74). */
function classifyAdded(input: { added: readonly CommandGlob[]; forms: readonly string[][] }): string | null {
  const matched = input.added.find(glob => input.forms.some(form => meetsPrefix(glob, form)))
  return matched ? `On the workspace destructive list: ${matched.source}` : null
}

/** The script pattern a head's words meet, joined as a script body would hold them, or null for none (fix brief 7, A3b). */
function headScriptReason(heads: readonly string[][]): string | null {
  for (const head of heads) {
    const text = head.join(' ')
    const met = SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(text))
    if (met) return met.reason
  }
  return null
}

function classifyShellScript(argv: ParsedArgv): string | null {
  if (!SHELL_COMMANDS.has(argv.command)) return null
  const script = argv.positionals.join('\n')
  return SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(script))?.reason ?? null
}
