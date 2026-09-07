import type { ParsedArgv } from '../../argv.js'
import { argvSignature, hasFlag, parseArgv, SHELL_COMMANDS } from '../../argv.js'
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

export function createDestructiveCommandRule(): PermissionRule {
  return {
    id: 'destructive_command',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'exec') return null
      const argv = parseArgv(effect.command, effect.args)
      const reason = classifyArgv(argv) ?? classifyShellScript(argv)
      if (!reason) return null

      const subject = argvSignature(argv, effect.args)
      if (grants.subjectsFor('destructive_command').includes(subject)) return allowedVia('destructive_command', subject)
      // No 'always': a standing grant for a destructive signature defeats the gate.
      return ask('destructive_command', subject, reason, ['once', 'session'])
    },
  }
}

function classifyArgv(argv: ParsedArgv): string | null {
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

  return classifyGit(argv)
}

function classifyGit(argv: ParsedArgv): string | null {
  if (argv.command !== 'git') return null
  if (argv.subcommand === 'push' && hasFlag(argv, 'f', 'force', 'force-with-lease')) return 'Force push rewrites remote history'
  if (argv.subcommand === 'reset' && argv.longFlags.has('hard')) return 'git reset --hard discards local work'
  if (argv.subcommand === 'clean' && hasFlag(argv, 'f', 'force')) return 'git clean deletes untracked files'
  if (argv.subcommand === 'checkout' && hasFlag(argv, 'f', 'force')) return 'git checkout --force discards local changes'
  return null
}

function classifyShellScript(argv: ParsedArgv): string | null {
  if (!SHELL_COMMANDS.has(argv.command)) return null
  const script = argv.positionals.join('\n')
  return SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(script))?.reason ?? null
}
