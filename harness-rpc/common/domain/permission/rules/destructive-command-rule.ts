import type { ParsedArgv } from '../../argv.js'
import { commandSubject, gitInvocation, hasFlag, parseArgv, parseGitSubcommand, SHELL_COMMANDS } from '../../argv.js'
import type { CommandGlob } from '../../command-glob.js'
import { allForms, commandForms } from '../../command-forms.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask } from '../decision.js'

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'pkexec'])
const DISK_COMMANDS = new Set(['mkfs', 'fdisk', 'parted', 'wipefs', 'blkdiscard', 'shred', 'sgdisk'])

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
 * `nice` or `timeout 5`, and each statement of a shell body (the continuation review, "Seen outside this
 * range"). The subject asked and granted stays the call's own argv (owner decision D17).
 */
export function createDestructiveCommandRule(input: { added?: readonly CommandGlob[] } = {}): PermissionRule {
  const added = input.added ?? []
  return {
    id: 'destructive_command',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'exec') return null
      const forms = commandForms(effect.command, effect.args)
      const reason = firstReason(allForms(forms)) ?? (forms.unread ? UNREAD_REASON : null) ?? classifyAdded({ added, forms: allForms(forms) })
      if (!reason) return null

      // The shown command and its lossless identity (owner decision D17): never joined, never cut, no
      // credential the display redacts; a grant made before this form matches nothing.
      const subject = commandSubject(effect.command, effect.args)
      if (grants.subjectsFor('destructive_command').includes(subject)) return allowedVia('destructive_command', subject)
      // No 'always': a standing grant for a destructive signature defeats the gate.
      return ask('destructive_command', subject, reason, ['once', 'session'])
    },
  }
}

const UNREAD_REASON = 'Wrappers or shell bodies nest deeper than Buckle reads; asked rather than guessed at'

function firstReason(forms: readonly string[][]): string | null {
  for (const [command = '', ...args] of forms) {
    const argv = parseArgv(command, args)
    const reason = classifyArgv(argv, args) ?? classifyShellScript(argv)
    if (reason) return reason
  }
  return null
}

function classifyArgv(argv: ParsedArgv, args: readonly string[]): string | null {
  if (PRIVILEGE_COMMANDS.has(argv.command)) return `${argv.command} escalates privileges`
  if (DISK_COMMANDS.has(argv.command) || argv.command.startsWith('mkfs.')) return `${argv.command} destroys disk contents`

  if (argv.command === 'rm' && hasFlag(argv, 'r', 'recursive') ) return 'Recursive delete'
  if (argv.command === 'rm' && hasFlag(argv, 'f', 'force')) return 'Forced delete'
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

function classifyAdded(input: { added: readonly CommandGlob[]; forms: readonly string[][] }): string | null {
  const matched = input.added.find(glob => input.forms.some(form => glob.matchesPrefix(form)))
  return matched ? `On the workspace destructive list: ${matched.source}` : null
}

function classifyShellScript(argv: ParsedArgv): string | null {
  if (!SHELL_COMMANDS.has(argv.command)) return null
  const script = argv.positionals.join('\n')
  return SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(script))?.reason ?? null
}
