import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { redactCredentials } from '@5straps/runtime'

/**
 * Interpreters whose positional is a script body rather than an argument list. rbash, ash, mksh, yash, and posh are
 * POSIX shells too, read as bash is; the C shells and busybox's shell applets are interpreters Buckle does not read.
 */
export const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'rbash', 'ash', 'mksh', 'yash', 'posh'])

export interface ParsedArgv {
  command: string
  shortFlags: Set<string>
  longFlags: Map<string, string | null>
  positionals: string[]
  subcommand: string | null
}

/**
 * Splits a command line the way getopt-style tools read it: clustered short flags expand,
 * `--name=value` splits, and a bare `--` ends flag parsing.
 */
export function parseArgv(command: string, args: string[]): ParsedArgv {
  const shortFlags = new Set<string>()
  const longFlags = new Map<string, string | null>()
  const positionals: string[] = []
  let flagsEnded = false

  for (const argument of args) {
    if (flagsEnded || argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument)
      continue
    }
    if (argument === '--') {
      flagsEnded = true
      continue
    }
    if (argument.startsWith('--')) {
      const separator = argument.indexOf('=')
      if (separator === -1) longFlags.set(argument.slice(2).toLowerCase(), null)
      else longFlags.set(argument.slice(2, separator).toLowerCase(), argument.slice(separator + 1))
      continue
    }
    for (const character of argument.slice(1)) shortFlags.add(character)
  }

  const base = baseCommand(command)
  return {
    command: base,
    shortFlags,
    longFlags,
    positionals,
    subcommand: (base === 'git' ? gitInvocation(args).subcommand : positionals[0])?.toLowerCase() ?? null,
  }
}

/** git's own options before the subcommand that take the next word as their value (git.c, handle_options). */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--shallow-file'])

/**
 * The subcommand git runs and the words it hands that subcommand, found as git finds them (review M6): git's
 * own options come first (`-C <dir>`, `-c <name>=<value>`, `--git-dir <dir>`, `--work-tree <dir>`, the
 * `--name=value` forms, and the ones with no value such as `-p`, `--no-pager` or `--bare`). An unknown option is
 * taken to have no value. Git refuses a bare `--` there ("unknown option: --", exit 129), so it names no
 * subcommand and is marked `doubleDash`: the destructive gate asks about it rather than guess what a git that
 * took it would run (review L11 of the slice 5 re-review).
 */
export function gitInvocation(args: readonly string[]): { subcommand: string | null; args: string[]; doubleDash?: true } {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === '--') return { subcommand: null, args: [], doubleDash: true }
    if (!word.startsWith('-') || word === '-') return { subcommand: word, args: args.slice(index + 1) }
    if (GIT_OPTIONS_WITH_VALUE.has(word)) index++
  }
  return { subcommand: null, args: [] }
}

/**
 * The options of each subcommand the destructive gate reads that take the next word as their value, as git's
 * parse-options reads them: a value it takes may be `--` or `--force`, which then ends nothing and sets nothing
 * (review L1 of the continuation review: `git push -o -- --force` force-pushed and `git clean -e -- -f` deleted).
 * Only the subcommands the gate classifies are listed; any other subcommand is read with no value options.
 */
const GIT_VALUE_OPTIONS: Readonly<Record<string, { short: string; long: readonly string[] }>> = {
  push: { short: 'o', long: ['push-option', 'repo', 'receive-pack', 'exec', 'recurse-submodules'] },
  clean: { short: 'e', long: ['exclude'] },
  reset: { short: '', long: ['pathspec-from-file'] },
  checkout: { short: 'bB', long: ['orphan', 'conflict', 'pathspec-from-file'] },
}

/**
 * A git subcommand's words as its parse-options reads them: an option that takes a value takes the rest of its
 * short cluster (`-o--force`) or else the next word, whatever that word is; a long option given without `=`
 * takes the next word when its name, or a prefix of it git would expand (`--ex` is `--exclude`), takes a value;
 * and only a `--` no option took ends the options.
 */
export function parseGitSubcommand(subcommand: string | null, args: readonly string[]): ParsedArgv {
  const values = (subcommand ? GIT_VALUE_OPTIONS[subcommand] : undefined) ?? { short: '', long: [] }
  const shortFlags = new Set<string>()
  const longFlags = new Map<string, string | null>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (word === '-' || !word.startsWith('-')) {
      positionals.push(word)
      continue
    }
    if (word.startsWith('--')) {
      const separator = word.indexOf('=')
      const name = (separator === -1 ? word.slice(2) : word.slice(2, separator)).toLowerCase()
      longFlags.set(name, separator === -1 ? null : word.slice(separator + 1))
      if (separator === -1 && name.length > 0 && values.long.some(option => option.startsWith(name))) index++
      continue
    }
    for (let offset = 1; offset < word.length; offset++) {
      const character = word.charAt(offset)
      shortFlags.add(character)
      if (!values.short.includes(character)) continue
      if (offset === word.length - 1) index++
      break
    }
  }
  return { command: 'git', shortFlags, longFlags, positionals, subcommand }
}

export function hasFlag(argv: ParsedArgv, short: string | null, ...long: string[]): boolean {
  if (short && argv.shortFlags.has(short)) return true
  return long.some(name => argv.longFlags.has(name))
}

/**
 * A command's identity for a grant (owner decision D17): the sha256 of the canonical JSON array
 * `[command, ...args]`, every word whole. Two argument lists that join to the same text, `-f 'a b'`
 * and `-f a b`, or that share a long prefix, have different identities; nothing is cut or joined.
 */
export function argvIdentity(command: string, args: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([command, ...args])).digest('hex')
}

/**
 * A command as a person reads it: the script body of a shell's `-c` as written and every other word read as one value
 * (owner ruling B: a whole URL or a named argument hides its credential), then quoted as a POSIX shell would need it,
 * so its boundaries show (`rm -f 'a b'` is not `rm -f a b`). Display only: the grant matches on argvIdentity.
 */
export function shownCommand(command: string, args: readonly string[]): string {
  return shownWords(command, args).map((word, index) => shellQuote(word, index === 0)).join(' ')
}

/** A command's words as shownCommand shows each, before quoting: what the decision AI is sent as argv (D91). */
export function shownWords(command: string, args: readonly string[]): string[] {
  const words = [command, ...args]
  const bodies = shellBodyIndexes(words)
  return words.map((word, index) => (bodies.has(index) ? word : redactCredentials(word, 'value')))
}

/** Shell options before the script that take the next word as their value (`-o pipefail`, `--rcfile <file>`). */
const SHELL_VALUE_OPTIONS = new Set(['o', 'O'])
const SHELL_LONG_VALUE_OPTIONS = new Set(['--rcfile', '--init-file'])

/**
 * Which words of a command line are a shell's `-c` script body: after any word naming a shell (SHELL_COMMANDS), so
 * one behind `env`, `sudo` or `timeout` counts, the first word past that shell's options when they include `c`.
 * The body is shown as written, every other word read as one value.
 */
export function shellBodyIndexes(words: readonly string[]): Set<number> {
  const bodies = new Set<number>()
  for (let index = 0; index < words.length; index++) {
    if (!SHELL_COMMANDS.has(baseCommand(words[index]!))) continue
    let script = false
    let cursor = index + 1
    for (; cursor < words.length; cursor++) {
      const word = words[cursor]!
      if (word === '--' || word === '-') {
        cursor++
        break
      }
      if (word.length < 2 || (word[0] !== '-' && word[0] !== '+')) break
      if (word.startsWith('--')) {
        if (SHELL_LONG_VALUE_OPTIONS.has(word)) cursor++
        continue
      }
      if (word[0] === '-' && word.includes('c')) script = true
      if ([...word.slice(1)].some(flag => SHELL_VALUE_OPTIONS.has(flag))) cursor++
    }
    if (script && cursor < words.length) {
      bodies.add(cursor)
      index = cursor
    }
  }
  return bodies
}

/**
 * Where a shell takes its script from: a `-c` string, a file, its own input, another descriptor or device
 * (`/dev/fd/3`), or nowhere (`bash -c` with no string, `bash --version`).
 */
export type ShellScriptSource = 'command' | 'missingCommand' | 'file' | 'input' | 'descriptor' | 'none'

/** A path through which a process reads its own input, once normalised: /dev/stdin, /dev/fd/0, /proc/self/fd/0, /proc/thread-self/fd/0. */
const OWN_INPUT = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/(?:self|thread-self)\/fd\/0)$/
/** Paths under /dev or /proc, once normalised: a descriptor, a device, or another process's file, never a script file. */
const DEVICE_PATH = /^\/(?:dev|proc)(?:\/|$)/

/**
 * What a script operand names, as the kernel would find it before any symbolic link Buckle cannot see: its own input
 * (`input`), another descriptor or device (`descriptor`), or a file. The path is normalised first, repeated slashes
 * collapsed and `.` and `..` segments resolved, so `//dev/stdin` and `/dev/./fd/3` are what they name; a relative path
 * climbing with `..` may reach the root, so its leading `..` segments are read as the root, and a relative `dev/` or
 * `proc/` path is read as from the root too.
 */
export function scriptOperandKind(operand: string): 'input' | 'descriptor' | 'file' {
  if (!operand.includes('/')) return 'file'
  const normal = posix.normalize(operand).replace(/^(?:\.\.\/)+/, '/')
  const absolute = normal.startsWith('/') ? normal : `/${normal}`
  if (OWN_INPUT.test(absolute)) return 'input'
  return DEVICE_PATH.test(absolute) ? 'descriptor' : 'file'
}

/** Long options after which a shell prints and runs nothing. */
const SHELL_INFO_OPTIONS = new Set(['--version', '--help'])

/** Where a shell call takes its script from (shellScriptOperand). */
export function shellScriptSource(args: readonly string[]): ShellScriptSource {
  return shellScriptOperand(args).source
}

/**
 * Where a shell call takes its script from, and the operand that names it, its options read as shellBodyIndexes reads
 * them: with `c` among its options the first operand is the script, and with none the call has no script
 * (`missingCommand`); with `s`, with no operand, or with an operand naming its own input, the script is that input; an
 * operand naming another descriptor or a device is `descriptor`; any other operand is a script file.
 */
export function shellScriptOperand(args: readonly string[]): { source: ShellScriptSource; operand?: string } {
  const { command, input, index, info } = shellOptions(args)
  if (info) return { source: 'none' }
  const operand = args[index]
  if (command) return operand === undefined ? { source: 'missingCommand' } : { source: 'command', operand }
  if (input || operand === undefined) return { source: 'input', operand }
  const kind = scriptOperandKind(operand)
  return { source: kind === 'file' ? 'file' : kind, operand }
}

/** The startup files a shell call's `--rcfile` and `--init-file` options name, which an interactive bash runs first. */
export function shellStartupFiles(args: readonly string[]): string[] {
  return shellOptions(args).startup
}

/**
 * How a program reads one of the words before the command it runs, as its option parser reads them: an option cluster,
 * with the offset at which a value attached to it starts (null for none); the value of the option before it; or an
 * operand. `runs` marks a value that names or supplies what runs (ssh -o, su -c and -s).
 */
export type LeadingWord =
  | { word: string; role: 'option'; valueAt: number | null; runs?: true }
  | { word: string; role: 'value'; runs?: true }
  | { word: string; role: 'operand' }

/**
 * A shell call's words before its `-c` string or script operand: its options, which take no attached value, and the
 * value of each `-o`, `-O`, `--rcfile`, and `--init-file`; then where that operand is, and whether it is a `-c` string.
 */
export function shellLeadingWords(args: readonly string[]): { leading: LeadingWord[]; operand: number; command: boolean } {
  const { leading, index, command } = shellOptions(args)
  return { leading, operand: index, command }
}

/**
 * A shell call's options as shellBodyIndexes reads them, up to its first operand: whether they include `c` and `s`, where
 * the operand is, whether a long option only prints (`--version`), the file each `--rcfile` or `--init-file` names, and
 * the words read on the way (LeadingWord).
 */
function shellOptions(args: readonly string[]): { command: boolean; input: boolean; index: number; info: boolean; startup: string[]; leading: LeadingWord[] } {
  const options = { command: false, input: false, index: 0, info: false, startup: [] as string[], leading: [] as LeadingWord[] }
  const value = () => {
    const word = args[++options.index]
    if (word !== undefined) options.leading.push({ word, role: 'value' })
    return word
  }
  for (; options.index < args.length; options.index++) {
    const word = args[options.index]!
    if (word === '--' || word === '-') {
      options.index++
      break
    }
    if (word.length < 2 || (word[0] !== '-' && word[0] !== '+')) break
    options.leading.push({ word, role: 'option', valueAt: null })
    if (word.startsWith('--')) {
      options.info ||= SHELL_INFO_OPTIONS.has(word)
      if (!SHELL_LONG_VALUE_OPTIONS.has(word)) continue
      const file = value()
      if (file !== undefined) options.startup.push(file)
      continue
    }
    if (word[0] === '-' && word.includes('c')) options.command = true
    if (word[0] === '-' && word.includes('s')) options.input = true
    if ([...word.slice(1)].some(flag => SHELL_VALUE_OPTIONS.has(flag))) value()
  }
  return options
}

/** ssh's options that take a value, as OpenSSH's getopt string reads them (1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy). */
const SSH_VALUE_OPTIONS = 'bceilmopBDEFIJLOPQRSwW'
/** Options with which ssh opens no session of its own: -N and -W forward, -G prints its configuration, -V its version, -O controls a master, -Q queries. */
const SSH_NO_SESSION = 'NWGVOQ'
/** The `-o` settings whose value ssh runs as shell text, here (ProxyCommand, LocalCommand, KnownHostsCommand) or on the host (RemoteCommand). */
const SSH_COMMAND_SETTINGS = new Set(['proxycommand', 'localcommand', 'knownhostscommand', 'remotecommand'])
/** The characters OpenSSH's configuration reader calls whitespace (misc.h WHITESPACE). */
const SSH_BLANKS = ' \t\r\n'

/**
 * The next word of an ssh configuration line from `at`, as OpenSSH's strdelim reads it: up to a blank, an `=`, or a
 * `"`. A `"` is removed and the word runs on to the next `"`, which ends it, so `"ProxyCommand"` and `Proxy"Command"`
 * are both ProxyCommand; one `=` and the blanks around it are skipped after the word. Null for a quote that never closes.
 */
function sshConfigWord(line: string, at: number): { word: string; next: number } | null {
  const skipBlanks = (from: number) => {
    let index = from
    while (index < line.length && SSH_BLANKS.includes(line[index]!)) index++
    return index
  }
  let index = at
  while (index < line.length && !SSH_BLANKS.includes(line[index]!) && line[index] !== '"' && line[index] !== '=') index++
  if (index >= line.length) return { word: line.slice(at), next: line.length }
  if (line[index] === '"') {
    const close = line.indexOf('"', index + 1)
    if (close < 0) return null
    return { word: line.slice(at, index) + line.slice(index + 1, close), next: skipBlanks(close + 1) }
  }
  const equals = line[index] === '='
  let next = skipBlanks(index + 1)
  if (!equals && line[next] === '=') next = skipBlanks(next + 1)
  return { word: line.slice(at, index), next }
}

/**
 * The command an `-o` setting hands a shell, as OpenSSH's process_config_line reads it, or null for any other setting:
 * trailing blanks and form feeds dropped, the keyword read by sshConfigWord (a second word when the first is empty),
 * matched without case, and the command the rest of the line after any blanks and `=` signs.
 */
export function sshCommandSetting(value: string): { keyword: string; command: string } | null {
  const line = value.replace(/[ \t\r\n\f]+$/, '')
  let keyword = sshConfigWord(line, 0)
  if (keyword?.word === '') keyword = sshConfigWord(line, keyword.next)
  if (!keyword || keyword.word === '' || keyword.word.startsWith('#')) return null
  const name = keyword.word.toLowerCase()
  if (!SSH_COMMAND_SETTINGS.has(name)) return null
  let start = keyword.next
  while (start < line.length && (SSH_BLANKS.includes(line[start]!) || line[start] === '=')) start++
  return { keyword: name, command: line.slice(start) }
}

/** What an ssh call runs: shell text on the remote host, shell text here, or an interactive session. */
export interface SshInvocation {
  /** The words after the host joined with spaces, as ssh sends them for the remote shell to parse, and any RemoteCommand. */
  remote: string[]
  /** The words after the host, before ssh joins them. */
  words: string[]
  /** Each ProxyCommand, LocalCommand, and KnownHostsCommand, which ssh runs as shell text on this machine. */
  local: string[]
  /** Every `-o` value, as written. */
  settings: string[]
  /**
   * A command setting holds a `%` token, which ssh replaces with the host, the user, or the port before a shell runs the
   * text, and which may come from a configuration file Buckle does not read, so what runs is unknown. `%%` is a `%`.
   */
  tokens: boolean
  /** A host with no remote command and none of -N, -W, -G, -V, -O, or -Q: an interactive session. */
  session: boolean
  /** The words before the remote command: options, their values, and the host (LeadingWord). */
  leading: LeadingWord[]
}

/**
 * An ssh call read as OpenSSH reads it: options up to the host, the host, options again until the first other word
 * (ssh parses them a second time after the host unless a `--` ended the first pass), then the remote command. Any
 * other word starting `--` is an unknown option, after which ssh runs nothing; it is read as `--`, an over-read. A
 * lone `-` is a word. ssh runs a ProxyCommand here even with no remote command (real ssh, slice 7j probes).
 */
export function sshInvocation(args: readonly string[]): SshInvocation {
  const remote: string[] = []
  const local: string[] = []
  const settings: string[] = []
  const leading: LeadingWord[] = []
  let tokens = false
  let noSession = false
  let index = 0
  let terminated = false
  const options = () => {
    while (index < args.length) {
      const word = args[index]!
      if (word.startsWith('--')) {
        leading.push({ word, role: 'option', valueAt: null })
        index++
        terminated = word === '--'
        return
      }
      if (word.length < 2 || word[0] !== '-') return
      index++
      let taken = false
      for (let offset = 1; offset < word.length; offset++) {
        const flag = word[offset]!
        if (SSH_NO_SESSION.includes(flag)) noSession = true
        if (!SSH_VALUE_OPTIONS.includes(flag)) continue
        const attached = offset + 1 < word.length
        const value = attached ? word.slice(offset + 1) : args[index++]
        // An -o value is a configuration line, which may name a command ssh runs (ProxyCommand).
        const runs = flag === 'o' ? { runs: true as const } : {}
        leading.push({ word, role: 'option', valueAt: attached ? offset + 1 : null, ...runs })
        if (!attached && value !== undefined) leading.push({ word: value, role: 'value', ...runs })
        taken = true
        if (flag === 'o' && value !== undefined) settings.push(value)
        const setting = flag === 'o' && value !== undefined ? sshCommandSetting(value) : null
        if (setting) {
          // ssh reads `%%` as a `%` and any other `%` as a token it expands (percent_expand), left to right.
          tokens ||= setting.command.replaceAll('%%', '').includes('%')
          ;(setting.keyword === 'remotecommand' ? remote : local).push(setting.command.replaceAll('%%', '%'))
        }
        break
      }
      if (!taken) leading.push({ word, role: 'option', valueAt: null })
    }
  }
  options()
  if (index >= args.length) return { remote, words: [], local, settings, tokens, session: false, leading }
  leading.push({ word: args[index]!, role: 'operand' })
  index++
  if (!terminated) options()
  // ssh sends an empty command as no command, which opens a shell.
  const words = args.slice(index)
  const command = words.join(' ')
  if (command !== '') remote.unshift(command)
  return { remote, words, local, settings, tokens, session: remote.length === 0 && !noSession, leading }
}

/** su's options that take a value, as util-linux's getopt_long reads them (c:fg:G:lmpPs:u:hVw:, with their long names). */
const SU_VALUE_OPTIONS = 'cgGsuw'
const SU_LONG_OPTIONS: Readonly<Record<string, string>> = {
  command: 'c', 'session-command': 'c', group: 'g', 'supp-group': 'G', shell: 's', 'whitelist-environment': 'w',
  fast: 'f', login: 'l', 'preserve-environment': 'p', pty: 'P', help: 'h', version: 'V',
}

/** What a su call runs: a shell, with each command string or with the words after the user, or an interactive session. */
export interface SuInvocation {
  /** The -s or --shell value, or null for the user's login shell. */
  shell: string | null
  /** Each -c, --command, and --session-command string; getopt keeps the last, and every one is read. */
  commands: string[]
  /** The words after the user, which su hands to the shell after any command string. */
  operands: string[]
  /** No command string, no operands, and no --help or --version: an interactive session. */
  session: boolean
  /** Every word before a `--`, which getopt_long may read as an option wherever it stands (LeadingWord). */
  leading: LeadingWord[]
}

/**
 * A su call read as util-linux reads it: getopt_long permutes, so an option may follow the user, and only `--` ends the
 * options; the first other word is `-` (a login) or the user, and the words after the user go to the shell.
 */
export function suInvocation(args: readonly string[]): SuInvocation {
  let shell: string | null = null
  const commands: string[] = []
  const operands: string[] = []
  const leading: LeadingWord[] = []
  let info = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (word === '-' || !word.startsWith('-')) {
      leading.push({ word, role: 'operand' })
      operands.push(word)
      continue
    }
    const separator = word.indexOf('=')
    const long = word.startsWith('--') ? suLongOption(separator < 0 ? word.slice(2) : word.slice(2, separator)) : null
    const flags = long ?? word.slice(1)
    const read: LeadingWord[] = [{ word, role: 'option', valueAt: null }]
    for (let offset = 0; offset < flags.length; offset++) {
      const flag = flags[offset]!
      if (flag === 'h' || flag === 'V') info = true
      if (!SU_VALUE_OPTIONS.includes(flag)) continue
      const attached = long === null ? flags.slice(offset + 1) : separator < 0 ? '' : word.slice(separator + 1)
      const given = attached !== '' || (long !== null && separator >= 0)
      const value = given ? attached : args[++index]
      // The -c string is what runs, and the -s shell what runs it.
      const runs = flag === 'c' || flag === 's' ? { runs: true as const } : {}
      if (given) read[0] = { word, role: 'option', valueAt: long === null ? offset + 2 : separator + 1, ...runs }
      else if (value !== undefined) read.push({ word: value, role: 'value', ...runs })
      if (value !== undefined && flag === 'c') commands.push(value)
      if (value !== undefined && flag === 's') shell = value
      break
    }
    leading.push(...read)
  }
  if (operands[0] === '-') operands.shift()
  operands.shift()
  return { shell, commands, operands, session: !info && commands.length === 0 && operands.length === 0, leading }
}

/** A long su option as getopt_long matches it, as its short letter: the exact name, else the one name it begins; '' for none or several. */
function suLongOption(typed: string): string {
  if (Object.hasOwn(SU_LONG_OPTIONS, typed)) return SU_LONG_OPTIONS[typed]!
  const matches = Object.keys(SU_LONG_OPTIONS).filter(name => typed !== '' && name.startsWith(typed))
  return matches.length === 1 ? SU_LONG_OPTIONS[matches[0]!]! : ''
}

/**
 * The subject a destructive command is asked and granted under: the shown command, then its identity as
 * a shell comment. It never holds a credential the display redacts, and two commands share it only when
 * their words are the same, so a session grant covers exactly the command a person approved.
 */
export function commandSubject(command: string, args: readonly string[]): string {
  return `${shownCommand(command, args)}  # argv sha256 ${argvIdentity(command, args)}`
}

/** Words a POSIX shell reads as themselves; `=` only after the command word, where it cannot read as an assignment. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+:,./-]+$/
const PLAIN_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Whether a shell reads a word as itself, escaped or not, whichever shell it is: letters, digits, and `_ @ % + = : , . / -`. */
export function readsAsItself(word: string): boolean {
  return PLAIN_ARGUMENT.test(word)
}

/** The blanks GNU env -S splits on: space, tab, newline, vertical tab, form feed, and carriage return. */
const ENV_BLANKS = new Set([' ', '\t', '\n', '\v', '\f', '\r'])

/**
 * An env -S value split as GNU env splits it, for a value holding no backslash and no `${`, which is all env -S reads
 * as words without its own escapes: the six blanks above separate, single and double quotes group (with no backslash
 * neither escapes anything), and a `#` that starts a word comments out the rest. An unclosed quote, where env refuses
 * to run, reads to the end.
 */
export function envSplitWords(value: string): string[] {
  const words: string[] = []
  let word: string | null = null
  let quote: string | null = null
  for (const character of value) {
    if (quote !== null) {
      if (character === quote) quote = null
      else word += character
    } else if (ENV_BLANKS.has(character)) {
      if (word !== null) words.push(word)
      word = null
    } else if (character === '#' && word === null) break
    else if (character === "'" || character === '"') {
      quote = character
      word ??= ''
    } else word = (word ?? '') + character
  }
  if (word !== null) words.push(word)
  return words
}

function shellQuote(word: string, first: boolean): string {
  if ((first ? PLAIN_WORD : PLAIN_ARGUMENT).test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** `bash -c "..."` and its equivalents, whose script body hides the real command from a word glob. */
export function isShellWrapper(argv: ParsedArgv): boolean {
  return SHELL_COMMANDS.has(argv.command) && argv.shortFlags.has('c')
}

/** Where a shell starts a new command: a newline, `;`, `&`, `|`, a parenthesis, a backtick or `$(`. */
const STATEMENT_BREAK = /\n|;|&|\||`|\$\(|\(|\)/
const BREAK_CHARACTERS = new Set(['\n', ';', '&', '|', '`', '(', ')'])
/** The only characters bash splits words on: a carriage return, a form feed, or a no-break space is word text. */
const BLANKS = new Set([' ', '\t', '\n'])
/** Operator characters after which bash starts a new word, so a `#` right after one starts a comment. */
const OPERATOR_CHARACTERS = new Set([';', '&', '|', '<', '>'])
/**
 * Characters before a `(` that make it part of the word around it: `$(`, `<(`, `>(`, an array assignment `a=(`, and the
 * extended globs `@(`, `?(`, `*(`, `+(` and `!(`. Its `)` then ends no word, so a `#` after it is word text.
 */
const WORD_PAREN_BEFORE = new Set(['$', '<', '>', '=', '@', '?', '*', '+', '!'])
/** A `case` word anywhere in the text: its patterns close with a `)` that no `(` opened, which a count of parentheses cannot place. */
const CASE_WORD = /(?:^|[^A-Za-z0-9_])case(?:$|[^A-Za-z0-9_])/
/**
 * How many `$(...)` or backtick bodies inside double quotes or heredoc text nest before the rest is called unread. Each
 * level is one more statement holding the levels inside it, so this stays small.
 */
export const MAX_SUBSTITUTIONS = 4

/**
 * How many wrappers, shell bodies inside shell bodies, or heredoc bodies read whole inside one another nest before the
 * rest is called unread 'depth'. One reading of a 1 MB request at every level fits, and the whole-body passes stay
 * bounded. command-forms reads this same limit for the wrapper and shell-body chain.
 */
export const MAX_DEPTH = 8

/**
 * The statements of shell text, split where a shell would start a new command, so a pattern written for a command
 * line also meets `curl` inside `bash -c "... | curl ..."`: a newline, `;`, `&`, `|`, a parenthesis, a backtick and
 * `$(` start one, outside quotes, so `git clean -e ';' -f` keeps its `-f` (slice 7 review F2). Each `$(...)` or
 * backtick body inside double quotes is read as statements of its own. A `#` that starts a word comments out its
 * line, and a heredoc body is read line by line, its quotes ending with the line (slice 7b review W7B-4), and under
 * an unquoted delimiter as heredoc text too (heredocBodies). `deep` says substitutions nest past MAX_SUBSTITUTIONS
 * anywhere in the text, a heredoc body included, so some text was read only as part of the statement around it, and
 * `overDepth` that heredoc bodies read whole nest past MAX_DEPTH, so one was left unread (slice 7f review R7F-HR-4).
 * `unsureComment` says a `#` followed a `)` that Buckle cannot tell closes a word or a command (CASE_WORD, `!(`), so
 * whether the rest of its line is a comment is unknown; that `#` is read as word text. Every pass over the text, the
 * first and each re-reading of a line, a joined run, a heredoc body, or a backtick body, is charged against `meter`,
 * the characters the caller's read budget has left; a pass that would run past it reads nothing and sets
 * `overBudget`, so a request under the size cap cannot hold the reader for seconds (the 7h to 7k review: eight
 * heredocs fed to bash around backtick bodies took 33.7 s to read).
 */
export function shellStatementList(text: string, meter: CharacterMeter = { characters: Number.POSITIVE_INFINITY }, feedsShell: (owner: string) => boolean = () => true): StatementList {
  const found: Found = { statements: [], flags: [], heads: [], headFlags: [], feedsShell, fedStatements: [], fedHeads: [], defines: false }
  const limits = unquotedSplit(text, SHELL_TEXT, 0, meter, found, 0)
  markFed(found)
  const seen = merged(found.statements, found.flags)
  return { statements: [...seen.keys()], seen, heads: merged(found.heads, found.headFlags), ...limits }
}

/**
 * What the readings of shell text knew of a statement or a command, across every place they met it: `net` when every
 * one was a safety net, a reading of heredoc text no shell is sure to run as such (SAFETY_NET); `whole` when one met it
 * as a whole simple command, not a piece of one a substitution cut nor text that runs none; `fed` when, in one, its input
 * on some descriptor may come from the call's own text (FED).
 */
export interface Seen { net: boolean; whole: boolean; fed: boolean }

/**
 * The statements of shell text (shellStatementList), what was seen of each, and each simple command a substitution cut,
 * whole (a head): its text with every substitution, array, extended glob, and arithmetic body replaced by `$()`, so its
 * words show which word is the command word, as the cut pieces cannot.
 */
export interface StatementList extends SplitLimits {
  statements: string[]
  seen: ReadonlyMap<string, Seen>
  heads: ReadonlyMap<string, Seen>
}

/** Each text without the blanks around it, once, with what was seen of it wherever a reading met it. */
function merged(texts: readonly string[], flags: readonly number[]): Map<string, Seen> {
  const seen = new Map<string, Seen>()
  for (let index = 0; index < texts.length; index++) {
    const text = trimmed(texts[index]!)
    if (text === '') continue
    const net = (flags[index]! & SAFETY_NET) !== 0
    const whole = (flags[index]! & NOT_WHOLE) === 0
    const fed = (flags[index]! & FED) !== 0
    const known = seen.get(text)
    if (known === undefined) seen.set(text, { net, whole, fed })
    else {
      known.net &&= net
      known.whole ||= whole
      known.fed ||= fed
    }
  }
  return seen
}

/**
 * What every reading of one text found, in the order it found it: each statement and each head, with its flags; and
 * `feedsShell`, which says whether the command owning a heredoc (its statement or head) may feed the body to a shell.
 * `fedStatements` and `fedHeads` hold, as start and end pairs, the runs of statements and heads whose input may come
 * from the call's own text (a pipeline after a `|`, a compound command a feed redirects), marked FED once read; and
 * `defines` says the text defines a function, which may run anywhere it is called, fed or not.
 */
interface Found {
  statements: string[]
  flags: number[]
  heads: string[]
  headFlags: number[]
  feedsShell: (owner: string) => boolean
  fedStatements: number[]
  fedHeads: number[]
  defines: boolean
}

/**
 * Marks FED every statement and head inside a fed run; and, when the text defines a function and anything in it is
 * fed, every one, since a function runs its body wherever it is called and Buckle does not follow the call.
 */
function markFed(found: Found): void {
  const runs = (flags: number[], spans: readonly number[]) => {
    if (spans.length === 0) return
    const depth = new Int32Array(flags.length + 1)
    for (let index = 0; index < spans.length; index += 2) {
      depth[spans[index]!]!++
      depth[spans[index + 1]!]!--
    }
    let open = 0
    for (let index = 0; index < flags.length; index++) {
      open += depth[index]!
      if (open > 0) flags[index]! |= FED
    }
  }
  runs(found.flags, found.fedStatements)
  runs(found.headFlags, found.fedHeads)
  if (!found.defines || !(found.flags.some(flags => (flags & FED) !== 0) || found.headFlags.some(flags => (flags & FED) !== 0))) return
  for (let index = 0; index < found.flags.length; index++) found.flags[index]! |= FED
  for (let index = 0; index < found.headFlags.length; index++) found.headFlags[index]! |= FED
}

/**
 * Met only by a safety net, a reading of heredoc text that reads more than a shell runs: a body's lines read one at a
 * time or joined (a line inside a quoted string spanning lines is no command), or a body read whole that its command
 * feeds to no shell (a Makefile fed to `cat`).
 */
const SAFETY_NET = 1
/** No whole command: a piece of a command a substitution cut, or text inside a body that runs none. */
const NOT_WHOLE = 2
/**
 * Its input, on some descriptor, may come from the call's own text: a pipe from a command in it, a heredoc, a here-string,
 * or a process substitution, on the command itself or on a compound command or a pipeline holding it.
 */
const FED = 4

/** What a head holds in place of each substitution or pattern body: a word part a shell expands. */
const SUBSTITUTED = '$()'

/** The characters a reading may still pass over, shared by every pass of one check. */
export interface CharacterMeter { characters: number }

/** What a reading of shell text met that it could not read whole, as shellStatementList names each. */
export interface SplitLimits { deep: boolean; overDepth: boolean; unsureComment: boolean; overBudget: boolean }

const noLimits = (): SplitLimits => ({ deep: false, overDepth: false, unsureComment: false, overBudget: false })

/** Adds the limits one reading met to those of the reading around it. */
function meet(into: SplitLimits, from: SplitLimits): void {
  into.deep ||= from.deep
  into.overDepth ||= from.overDepth
  into.unsureComment ||= from.unsureComment
  into.overBudget ||= from.overBudget
}

/**
 * A statement without the blanks around it, only the space, tab, and newline bash splits on. A blank a backslash escapes
 * is part of a word (`\ `), so it stays; a backslash before a newline that ends the statement continues the line into
 * nothing, so both go.
 */
function trimmed(statement: string): string {
  let start = 0
  while (start < statement.length && BLANKS.has(statement[start]!)) start++
  const text = statement.slice(start)
  let end = text.length
  while (end > 0 && BLANKS.has(text[end - 1]!)) end--
  let backslashes = 0
  while (backslashes < end && text[end - 1 - backslashes] === '\\') backslashes++
  if (end === text.length || backslashes % 2 === 0) return text.slice(0, end)
  return text[end] === '\n' ? text.slice(0, end - 1) : text.slice(0, end + 1)
}

/**
 * A statement split at every separator, quoted or not, so a command inside a quoted string another program runs is
 * met too: candidates to judge besides the statement. Empty when it holds no separator.
 */
export function statementPieces(statement: string): string[] {
  if (!STATEMENT_BREAK.test(statement)) return []
  return statement.split(STATEMENT_BREAK).map(piece => piece.trim()).filter(piece => piece !== '' && piece !== statement)
}

/**
 * `heredoc` is the text of a heredoc body under an unquoted delimiter: like `"`, but no quote ends it. `${` is the
 * inside of a parameter expansion's braces, where blanks and operators are word text, quotes nest as bash nests them,
 * and only its `}` ends it.
 */
type Quote = null | "'" | "$'" | '"' | 'heredoc' | '${'

/** One level of unquoted shell text: the text itself, or a `$(...)` or backtick body inside double quotes or heredoc text. */
interface SplitLevel {
  start: number
  closer: ')' | '`' | null
  parens: number
  quote: Quote
  /** The quote each quote open at this level was opened inside, innermost last, so closing one goes back to it. */
  quotes: Quote[]
  /** Where a backtick level's body starts, and whether double quotes hold it, so `\"` in it is an escape too. */
  body: number
  doubleQuoted: boolean
  /** Where the body of a backtick met at this level outside quotes starts, until its closing backtick; null when none is open. */
  backtick: number | null
  /**
   * Whether the next character outside quotes starts a word, so a `#` there starts a comment, as bash's read_token
   * starts one: after an unescaped blank, a newline, or an operator, at the start of a body, and after a `)` that closes
   * a command rather than a word. A continuation keeps what was before it. 'unsure' after a `)` Buckle cannot place.
   */
  wordStart: boolean | 'unsure'
  /**
   * Each `(` open at this level outside quotes: part of a word (`$(`, `<(`, `a=(`), a command's, or one that may be
   * either (`!(`); `body` when its text is read as a body of its own, which the command around it goes on after.
   */
  opens: Array<{ kind: ParenKind; body: boolean }>
  /** The last character read at this level outside quotes that no backslash escaped, or '' after an escaped one. */
  previous: string
  /** Whether that character started a word. */
  previousStarted: boolean
  /** The simple command being read at this level. */
  command: CommandText
  /** The commands a body outside quotes (`$(`, a backtick, `a=(`) interrupted at this level, the innermost last. */
  interrupted: CommandText[]
  /** Where the input of the commands read here may come from the call's own text, and that of each body interrupted. */
  feeding: Feeding
  feedings: Feeding[]
}

type ParenKind = 'word' | 'command' | 'unsure'

/**
 * A simple command as a reading meets it: `text` holds what was read of it before `from`, each body a substitution,
 * an array, an extended glob, or arithmetic cut out of it replaced by SUBSTITUTED (`from` is -1 while such a body is
 * open); `cut` once one was; `runs` false for text that runs no command (an array's elements, a glob's patterns,
 * arithmetic), whose words are judged as no command word. `feed` once a heredoc, a here-string, or a process
 * substitution feeds it; `statements` and `heads` count what was found before it, and `pieces` lists its own pieces once
 * it was cut. When the command ends, the same object is reset to read the next one; a body that interrupts it gets an
 * object of its own. So `pattern` and `subject`, which outlive a command, belong to the body: `pattern` once a case's
 * patterns follow (after `case WORD in`, a `|` between patterns, or `;;`, `;&` or `;;&`) until one ends or an `esac`,
 * and `subject` after a `case WORD` whose `in` is on a later line.
 */
interface CommandText { text: string; from: number; cut: boolean; runs: boolean; feed: boolean; statements: number; heads: number; pieces: number[] | null; pattern: boolean; subject: boolean; join: Join | null }

/**
 * The command before the `&` of a `&>` or `&>>` cut, which bash reads as one redirection of the command around it (`rm
 * &>/dev/null -rf x` runs rm -rf x), while dash reads the `&` as a background job: its text up to that `&` with the `&`
 * read as a blank, its body cut into `$()` where one was (`cut`), and whether a feed reached it (fix brief 7, A1b).
 */
interface Join { text: string; cut: boolean; feed: boolean }

const commandAt = (from: number, runs: boolean, found: Found): CommandText =>
  ({ text: '', from, cut: false, runs, feed: false, statements: found.statements.length, heads: found.heads.length, pieces: null, pattern: false, subject: false, join: null })

/** How many statements and heads were found before a point of the reading. */
interface Mark { statements: number; heads: number }

/**
 * Where the input of the commands read in one body (a text, or a substitution inside it) may come from the call's own
 * text: from `fed` on, after an `exec` a feed redirects; from `pipe` on, after a `|`,
 * until the pipeline ends outside the compound commands open when it began (`pipeDepth`). `compounds` marks where each
 * open compound command began (`{`, `(`, if, while, until, for, select, case), so a feed on its closing word reaches
 * all of it, and `closed` the one a `)` just closed, whose redirections the next command holds.
 */
interface Feeding { fed: Mark | null; pipe: Mark | null; pipeDepth: number; compounds: Mark[]; closed: Mark | null }

const unfed = (): Feeding => ({ fed: null, pipe: null, pipeDepth: 0, compounds: [], closed: null })

/** Characters the reading outside quotes acts on; every other one is word text, and so is any code point past ASCII. */
const SPECIAL_OUTSIDE = new Uint8Array(128)
for (const character of '\\`\'"#<>;&|() \t\n$') SPECIAL_OUTSIDE[character.charCodeAt(0)] = 1
const plainOutside = (code: number): boolean => code >= 128 || SPECIAL_OUTSIDE[code] === 0
/** Characters the reading inside a parameter expansion's braces acts on: a backslash, a quote, `$`, a backtick, and `}`. */
const plainInBraces = (code: number): boolean => code !== 92 && code !== 39 && code !== 34 && code !== 36 && code !== 96 && code !== 125
/** Whether text holds a character the reading outside quotes acts on other than a blank, or heredoc text one it acts on. */
const SPECIAL_ANYWHERE_OUTSIDE = /[\\`'"#<>;&|()\n]/
const SPECIAL_IN_HEREDOC = /[\\`$]/
/** Each such character outside quotes, and a character that opens a body in heredoc text. */
const EVERY_SPECIAL_OUTSIDE = /[\\`'"#<>;&|()\n]/g
const SUBSTITUTION_IN_HEREDOC = /[`$]/

/**
 * Whether the only characters in shell text the reading acts on, blanks aside, are backslashes, each escaping the
 * character after it (a newline too, which it joins away) or ending the text: such text is word text throughout.
 */
function onlyEscapes(text: string): boolean {
  EVERY_SPECIAL_OUTSIDE.lastIndex = 0
  for (let match = EVERY_SPECIAL_OUTSIDE.exec(text); match !== null; match = EVERY_SPECIAL_OUTSIDE.exec(text)) {
    if (match[0] !== '\\') return false
    EVERY_SPECIAL_OUTSIDE.lastIndex = match.index + 2
  }
  return true
}
/** Characters the reading inside double quotes or heredoc text acts on: a backslash, a double quote, a backtick, and `$`. */
const plainInQuotes = (code: number): boolean => code !== 92 && code !== 34 && code !== 96 && code !== 36

/** A level's reading state at its start, where a word starts; `runs` false for heredoc text and arithmetic, no command. */
const levelStart = (start: number, closer: SplitLevel['closer'], quote: Quote, doubleQuoted: boolean, runs: boolean, found: Found): SplitLevel =>
  ({ start, closer, parens: 0, quote, quotes: [], body: start, doubleQuoted, backtick: null, wordStart: true, opens: [], previous: '', previousStarted: false, command: commandAt(start, runs, found), interrupted: [], feeding: unfed(), feedings: [] })

/** A quote opens at this level inside the one open there, and closing it goes back to that one. */
function openQuote(level: SplitLevel, quote: Quote): void {
  level.quotes.push(level.quote)
  level.quote = quote
}

function closeQuote(level: SplitLevel): void {
  level.quote = level.quotes.pop() ?? null
}

/** The reserved words that open a compound command, close one, or come before a command inside one. */
const COMPOUND_OPENERS = new Set(['{', 'if', 'while', 'until', 'for', 'select', 'case'])
const COMPOUND_CLOSERS = new Set(['}', 'fi', 'done', 'esac'])
const BEFORE_A_COMMAND = new Set(['then', 'else', 'elif', 'do', '!', 'time'])

/**
 * The reserved words a command's text starts with, as bash reads them only before a command: how many compound
 * commands they open, whether they close one, and whether the command is `exec` or defines a function. Of a case:
 * `patterns` when they are `case WORD in`, after which its patterns come; `subject` when they are `case WORD` alone,
 * whose `in` comes on a later line; `esac` when the command's word is `esac`. `first` is the first word.
 */
function leadingWords(text: string, from: number, to: number): { opens: number; closes: boolean; exec: boolean; defines: boolean; patterns: boolean; subject: boolean; esac: boolean; first: string } {
  const result = { opens: 0, closes: false, exec: false, defines: false, patterns: false, subject: false, esac: false, first: '' }
  let index = from
  for (let first = true; ; first = false) {
    while (index < to && BLANKS.has(text[index]!)) index++
    const start = index
    while (index < to && !BLANKS.has(text[index]!)) index++
    const word = text.slice(start, index)
    if (first) result.first = word
    if (word === 'esac') result.esac = true
    if (word === 'case') {
      const [subject, keyword] = shellTokensUpTo(text.slice(index, to), 2).tokens
      result.patterns = keyword?.raw === 'in'
      result.subject = subject !== undefined && keyword === undefined
    }
    if (first && word === 'exec') result.exec = true
    if (first && word === 'function') {
      result.defines = true
      // `function NAME {`: the name, then the body's opening brace.
      while (index < to && BLANKS.has(text[index]!)) index++
      while (index < to && !BLANKS.has(text[index]!)) index++
      continue
    }
    if (COMPOUND_CLOSERS.has(word)) result.closes = true
    if (COMPOUND_OPENERS.has(word)) result.opens++
    if (!COMPOUND_OPENERS.has(word) && !BEFORE_A_COMMAND.has(word)) return result
    // A loop's variable and a case word come next, not a command.
    if (word === 'for' || word === 'select' || word === 'case') return result
  }
}

/**
 * Whether the `((` whose first parenthesis is at `at` is arithmetic, as bash decides: the second parenthesis closes
 * with a `)` another `)` follows at once; otherwise bash reads a subshell inside a subshell or a substitution, whose
 * commands run (`(($x mark); true)` ran the command). A quote, a backtick, a backslash, or a newline before that close
 * reads as no arithmetic, which judges more words as commands, never fewer. The scan is charged to `meter`, and stops
 * where the meter runs out, so open parentheses cannot make a pass quadratic; the caller then reads no further.
 */
function arithmeticAt(text: string, at: number, meter: CharacterMeter): boolean {
  let depth = 1
  const stop = Math.min(text.length, at + 2 + Math.max(0, meter.characters))
  for (let index = at + 2; index < stop; index++) {
    const character = text[index]!
    if (character === '(') depth++
    else if (character === ')' && --depth === 0) {
      meter.characters -= index - at
      return text[index + 1] === ')'
    } else if (character === "'" || character === '"' || character === '`' || character === '\\' || character === '\n') {
      meter.characters -= index - at
      return false
    }
  }
  meter.characters -= stop === text.length ? text.length - at : stop - at + 1
  return false
}

/**
 * Whether the body a word's `(` opens runs commands: a command or process substitution (`$(`, `<(`, `>(`) unless it is
 * arithmetic, zsh's `=(` process substitution at a word start, and `!(`, which may be a negated subshell; an array's
 * `a=(` and the extended globs `@(`, `?(`, `*(`, and `+(` hold no command.
 */
function wordBodyRuns(previous: string, previousStarted: boolean, kind: ParenKind, arithmetic: boolean): boolean {
  if (kind === 'unsure') return true
  if (previous === '$') return !arithmetic
  if (previous === '<' || previous === '>') return true
  return previous === '=' && previousStarted
}

/** How unquotedSplit reads its text. */
interface SplitMode {
  /** Heredoc text: `'` and `"` are literal, and only each `$(...)` or backtick body in it is statements. */
  heredocText: boolean
  /** Whether a heredoc body is also read whole as shell text, its own nested bodies whole in turn up to MAX_DEPTH. */
  wholeBodies: boolean
}

const SHELL_TEXT: SplitMode = { heredocText: false, wholeBodies: true }
const SHELL_LINE: SplitMode = { heredocText: false, wholeBodies: false }
const HEREDOC_TEXT: SplitMode = { heredocText: true, wholeBodies: false }

/**
 * Text split at each separator outside quotes. A backslash outside single quotes escapes the next character, and
 * in `$'...'` too (slice 7b review W7B-5). Inside double quotes or heredoc text a `$(...)` or backtick body is split
 * as text of its own, its statements added to the rest; heredoc text itself is no statement, since the command it
 * is handed reads it, not the shell.
 *
 * Every statement and head is pushed to `found` with `flags` (SAFETY_NET for heredoc text no shell is sure to run). A
 * simple command a substitution, an array, an extended glob, or arithmetic cuts is also kept whole, as a head, each body
 * replaced by SUBSTITUTED, and its pieces are marked NOT_WHOLE, so its command word is judged on the head; so are the
 * statements of a body that runs no command (an array's elements, a glob's patterns, arithmetic).
 */
function unquotedSplit(text: string, mode: SplitMode, depth: number, meter: CharacterMeter, found: Found, flags: number): SplitLimits {
  const limits = noLimits()
  meter.characters -= text.length
  if (meter.characters < 0) return { ...limits, overBudget: true }
  // Text no character of which changes the reading is one whole statement as shell text and none as heredoc text.
  if (!(mode.heredocText ? SPECIAL_IN_HEREDOC : SPECIAL_ANYWHERE_OUTSIDE).test(text)) {
    if (!mode.heredocText) {
      found.statements.push(text)
      found.flags.push(flags)
    }
    return limits
  }
  // So is shell text whose only such characters are backslashes, each escaping the character after it (a body line
  // continued onto the next), as the reading below finds it, and heredoc text in which no `$` or backtick opens a body.
  if (mode.heredocText ? !SUBSTITUTION_IN_HEREDOC.test(text) : onlyEscapes(text)) {
    if (!mode.heredocText) {
      found.statements.push(text)
      found.flags.push(flags)
      found.defines ||= leadingWords(text, 0, text.length).defines
    }
    return limits
  }
  const levels: SplitLevel[] = [levelStart(0, null, mode.heredocText ? 'heredoc' : null, false, !mode.heredocText, found)]
  const heredocs: Heredoc[] = []
  const mark = (): Mark => ({ statements: found.statements.length, heads: found.heads.length })
  const fedRun = (from: Mark, to: Mark) => {
    found.fedStatements.push(from.statements, to.statements)
    found.fedHeads.push(from.heads, to.heads)
  }
  // Whether what is read next at this level is fed: inside a pipeline, or after an exec a feed redirects.
  const fedHere = (level: SplitLevel) => level.feeding.fed !== null || level.feeding.pipe !== null
  // A pipe feeds the commands after it until the pipeline ends outside the compound commands open when it began.
  const pipeInto = (feeding: Feeding) => {
    if (feeding.pipe !== null) return
    feeding.pipe = mark()
    feeding.pipeDepth = feeding.compounds.length
  }
  const pipelineEnds = (feeding: Feeding) => {
    if (feeding.pipe === null || feeding.compounds.length > feeding.pipeDepth) return
    fedRun(feeding.pipe, mark())
    feeding.pipe = null
  }
  // A body ends: whatever fed its commands feeds them up to here.
  const feedingEnds = (feeding: Feeding) => {
    const now = mark()
    if (feeding.fed !== null) fedRun(feeding.fed, now)
    if (feeding.pipe !== null) fedRun(feeding.pipe, now)
  }
  let mentionsCase: boolean | null = null
  // A piece of the command at this level ends at `at`, and the text goes on at `next`.
  const piece = (level: SplitLevel, at: number, next: number) => {
    const command = level.command
    if (command.cut) (command.pieces ??= []).push(found.statements.length)
    found.statements.push(text.slice(level.start, at))
    found.flags.push(flags | (command.cut || !command.runs ? NOT_WHOLE : 0))
    level.start = next
  }
  // The command at this level ends at `at`: its last piece, and the command whole when a body cut it. `joinGoesOn` says
  // another `&>` of the same chain cut it, so its whole is read only where the chain ends.
  const finish = (level: SplitLevel, at: number, next: number, joinGoesOn = false) => {
    const command = level.command
    const feeding = level.feeding
    const start = level.start
    piece(level, at, next)
    if (command.cut && command.from >= 0) command.text += text.slice(command.from, at)
    if (command.cut && command.runs) {
      found.heads.push(command.text)
      found.headFlags.push(flags)
    }
    // A heredoc, a here-string, or a process substitution feeds the command itself, not a substitution inside it.
    if (command.feed) {
      found.flags[found.flags.length - 1]! |= FED
      for (const index of command.pieces ?? []) found.flags[index]! |= FED
      if (command.cut && command.runs) found.headFlags[found.headFlags.length - 1]! |= FED
    }
    // A command a `&>` cut is read whole too, as bash runs it: a statement, or a head where a body was cut from it. A chain
    // of them is read once, where it ends, since bash runs the whole and dash the pieces, and no shell the command before
    // a later `&>`; the whole is charged to the meter as a pass is, and past it nothing is pushed (fix brief 8, A1c).
    const join = command.join
    if (join !== null && command.runs && !joinGoesOn) {
      const whole = join.text + (command.cut ? command.text : text.slice(start, at))
      const fed = command.feed || join.feed ? FED : 0
      meter.characters -= whole.length
      if (meter.characters < 0) limits.overBudget = true
      else if (command.cut || join.cut) {
        found.heads.push(whole)
        found.headFlags.push(flags | fed)
      } else {
        found.statements.push(whole)
        found.flags.push(flags | fed)
      }
    }
    // A compound command opens with its reserved word, and a feed on the word that closes one, or on the redirections
    // after a `)`, feeds all of it; an `exec` a feed redirects feeds every command after it.
    const words = command.cut ? leadingWords(command.text, 0, command.text.length) : leadingWords(text, start, at)
    for (let count = 0; count < words.opens; count++) feeding.compounds.push({ statements: command.statements, heads: command.heads })
    const closed = words.closes ? feeding.compounds.pop() : feeding.closed
    if (closed && command.feed) fedRun(closed, mark())
    feeding.closed = null
    if (words.exec && command.feed) feeding.fed ??= mark()
    found.defines ||= words.defines
    if (words.esac) command.pattern = false
    else if (words.patterns || (command.subject && words.first === 'in')) command.pattern = true
    command.subject = words.subject
    // Each heredoc this command owns keeps the command's text, whose words say whether a shell is fed the body.
    let owner: HeredocOwner | null = null
    for (const heredoc of heredocs) {
      if (heredoc.owner === command && heredoc.command === undefined) {
        heredoc.command = owner ??= { text: command.cut ? command.text : text.slice(start, at), fed: (flags & FED) !== 0 || fedHere(level) }
      }
    }
    command.text = ''
    command.from = next
    command.cut = false
    command.feed = false
    command.statements = found.statements.length
    command.heads = found.heads.length
    command.pieces = null
    command.join = null
  }
  // What a `&>` or `&>>` whose `&` is at `amp` joins to the command after it (Join): the command so far, after any it
  // joined already, with the `&` read as a blank, so the shared redirection grammar reads `>word` or `>>word` there.
  const joinedBefore = (level: SplitLevel, amp: number): Join | null => {
    const command = level.command
    if (!command.runs) return null
    const own = command.cut ? command.text + (command.from >= 0 ? text.slice(command.from, amp) : '') : text.slice(level.start, amp)
    return { text: `${command.join?.text ?? ''}${own} `, cut: command.cut || command.join?.cut === true, feed: command.feed || command.join?.feed === true }
  }
  // A body opens at `at` inside the command at this level, which `marker` replaces in its head until the body ends.
  const cut = (command: CommandText, at: number, marker = SUBSTITUTED) => {
    if (command.from >= 0) command.text += text.slice(command.from, at) + marker
    command.from = -1
    command.cut = true
  }
  // A body outside quotes opens at `at` and starts at `next`: the command so far is a piece, and the body is read as
  // commands of its own (`runs`) until it closes.
  // A body's commands read the input of the command around it, which a fed run around that command already covers.
  const open = (level: SplitLevel, at: number, next: number, runs: boolean, marker = SUBSTITUTED) => {
    cut(level.command, at, marker)
    piece(level, at, next)
    level.interrupted.push(level.command)
    level.feedings.push(level.feeding)
    level.command = commandAt(next, runs, found)
    level.feeding = unfed()
  }
  // The body open at this level ends at `at`, and the command it interrupted goes on at `next`.
  const close = (level: SplitLevel, at: number, next: number) => {
    finish(level, at, next)
    feedingEnds(level.feeding)
    const command = level.interrupted.pop()
    const feeding = level.feedings.pop()
    if (command === undefined || feeding === undefined) return
    command.from = next
    level.command = command
    level.feeding = feeding
  }
  // A level ends at `at`: its command, and each one a body still open interrupted, the innermost first.
  const endLevel = (level: SplitLevel, at: number, next: number) => {
    finish(level, at, next)
    feedingEnds(level.feeding)
    for (let command = level.interrupted.pop(); command !== undefined; command = level.interrupted.pop()) {
      level.command = command
      level.feeding = level.feedings.pop() ?? unfed()
      finish(level, at, next)
      feedingEnds(level.feeding)
    }
  }
  // A backtick body is also read as bash runs it, its continuations and then its escapes removed first (joinedBacktick,
  // backtickView), and each body that removal reveals is read the same way in turn, each level counting against
  // MAX_DEPTH (slice 7h probes).
  const readBacktick = (body: string, doubleQuoted: boolean) => {
    if (!body.includes('\\')) return
    if (depth >= MAX_DEPTH) {
      limits.overDepth = true
      return
    }
    meet(limits, unquotedSplit(backtickView(joinedBacktick(body), doubleQuoted), mode.wholeBodies ? SHELL_TEXT : SHELL_LINE, depth + 1, meter, found, flags))
  }
  // What a `)` leaves: a word goes on after one that closes `$(` or `<(`, a new word starts after one that closes a
  // subshell, a group or a case pattern, and with a case word in the text or after `!(` Buckle cannot tell which.
  const afterClose = (opened: ParenKind): boolean | 'unsure' => {
    mentionsCase ??= CASE_WORD.test(text)
    if (opened === 'unsure' || mentionsCase) return 'unsure'
    return opened === 'command'
  }
  // Whether a `(` or `)` at `at` opens or ends a case pattern of the body read at this level, as bash parses the body,
  // rather than a parenthesis, a subshell, or the body itself: the body's command is in a case's pattern list (after
  // `case WORD in`, a `|`, or `;;`) and its word is no `esac` (a probe under bash 5.2: `x="$(case a in a) echo "q;r";;
  // esac)" git push` ran git push, which a `)` read as closing the substitution left in a statement led by `r`).
  const casePattern = (level: SplitLevel, at: number): boolean => {
    mentionsCase ??= CASE_WORD.test(text)
    const command = level.command
    if (!mentionsCase || !command.runs) return false
    const current = command.cut ? command.text + (command.from >= 0 ? text.slice(command.from, at) : '') : text.slice(level.start, at)
    const words = leadingWords(current, 0, current.length)
    return !words.esac && (command.pattern || words.patterns || (command.subject && words.first === 'in'))
  }
  // A quote or `$(...)` or backtick body opens at `index` inside double quotes, heredoc text, or a parameter expansion's
  // braces: a `$(...)` or backtick body is a level of its own, read as commands until its closer. The index to go on
  // from, or null past the read budget.
  const quotedSubstitution = (level: SplitLevel, index: number): number | null => {
    const character = text[index]
    if (levels.length > MAX_SUBSTITUTIONS) {
      limits.deep = true
      return index
    }
    cut(level.command, index)
    const arithmetic = character === '$' && text[index + 2] === '(' && arithmeticAt(text, index + 1, meter)
    if (meter.characters < 0) return null
    const at = character === '$' ? index + 1 : index
    levels.push(levelStart(at + 1, character === '`' ? '`' : ')', null, level.quote === '"', !arithmetic, found))
    return at
  }
  for (let index = 0; index < text.length; index++) {
    const level = levels.at(-1)!
    // Runs of characters that change nothing are passed over in one step, so each pass costs little per character.
    if (level.quote === "'") {
      const close = text.indexOf("'", index)
      if (close < 0) break
      index = close
      closeQuote(level)
      continue
    }
    if (level.quote === null && plainOutside(text.charCodeAt(index))) {
      let last = index
      while (last + 1 < text.length && plainOutside(text.charCodeAt(last + 1))) last++
      level.previousStarted = last === index && level.wordStart !== false
      level.wordStart = false
      level.previous = text[last]!
      index = last
      continue
    }
    if ((level.quote === '"' || level.quote === 'heredoc') && plainInQuotes(text.charCodeAt(index))) {
      while (index + 1 < text.length && plainInQuotes(text.charCodeAt(index + 1))) index++
      continue
    }
    if (level.quote === '${' && plainInBraces(text.charCodeAt(index))) {
      while (index + 1 < text.length && plainInBraces(text.charCodeAt(index + 1))) index++
      continue
    }
    const character = text[index]!
    if (level.quote === "$'") {
      if (character === '\\') index++
      else if (character === "'") closeQuote(level)
      continue
    }
    if (level.quote === '"' || level.quote === 'heredoc' || level.quote === '${') {
      const braces = level.quote === '${'
      if (character === '\\') index++
      else if (character === '"' && level.quote === '"') closeQuote(level)
      else if (character === '}' && braces) closeQuote(level)
      // Inside a parameter expansion's braces quotes nest, in double quotes and heredoc text too (a probe under bash 5.2:
      // `"${x:-'}'}"` and a heredoc line `${x:-"}"}` each kept the quoted `}` in the value).
      else if (braces && (character === "'" || character === '"')) openQuote(level, character)
      else if (braces && character === '$' && text[index + 1] === "'") {
        openQuote(level, "$'")
        index++
      } else if (character === '$' && text[index + 1] === '{') {
        openQuote(level, '${')
        index++
      } else if (character === '`' || (character === '$' && text[index + 1] === '(')) {
        const next = quotedSubstitution(level, index)
        if (next === null) return { ...limits, overBudget: true }
        index = next
      }
      continue
    }
    // Outside quotes: a character is word text unless it is a blank or an operator, after which a new word starts.
    const wordStart = level.wordStart
    const previous = level.previous
    const previousStarted = level.previousStarted
    level.wordStart = false
    level.previous = character
    level.previousStarted = wordStart !== false
    const heredocEnd = character === '<' && previous !== '<' ? heredocOperatorEnd(text, index) : -1
    if (character === '\\') {
      // A continuation (backslash-newline) is removed before words are read, so it leaves the reading as it was.
      const continuation = text[index + 1] === '\n'
      level.wordStart = continuation ? wordStart : false
      level.previous = continuation ? previous : ''
      level.previousStarted = continuation ? previousStarted : false
      index++
    } else if (character === '$' && text[index + 1] === '{') {
      // A parameter expansion is word text up to its closing brace, blanks and operators in it included (a probe under
      // bash 5.2: `x=${y:-a;b} git push` ran git push, which a split at the `;` left in a statement led by `b}`).
      openQuote(level, '${')
      level.previous = '{'
      index++
    } else if (character === level.closer && (character === '`' || (level.parens === 0 && !casePattern(level, index)))) {
      endLevel(level, index, index + 1)
      levels.pop()
      levels.at(-1)!.command.from = index + 1
      if (character === '`') readBacktick(text.slice(level.body, index), level.doubleQuoted)
    } else if (character === '`') {
      // A backtick outside quotes opens a body or closes the one open at this level; either way it splits a statement.
      // A word starts with the body, and the word around the substitution goes on after it. Its head writes it as a `$(`
      // cut does, `$$()`, so a `<` or `>` before it is never read as the `<(` or `>(` whose cut leaves `<$()` (fix brief 7,
      // A3b).
      if (level.backtick === null) {
        open(level, index, index + 1, true, `$${SUBSTITUTED}`)
        level.backtick = index + 1
        level.wordStart = true
      } else {
        close(level, index, index + 1)
        readBacktick(text.slice(level.backtick, index), false)
        level.backtick = null
      }
    } else if (character === "'") openQuote(level, previous === '$' ? "$'" : "'")
    else if (character === '"') openQuote(level, '"')
    else if (character === '#' && wordStart === true) {
      const stop = commentEnd(text, index, level.closer === '`' || level.backtick !== null)
      finish(level, index, stop)
      index = stop - 1
      level.wordStart = true
    } else if (character === '#' && wordStart === 'unsure') limits.unsureComment = true
    // A `<<` is a heredoc, but not inside a `<<<` here-string, whose second `<` would otherwise open one; a continuation
    // between or after its characters is removed first (heredocOperatorEnd).
    else if (heredocEnd >= 0) {
      level.command.feed = true
      const heredoc = heredocAt(text, heredocEnd, level.command)
      if (heredoc) heredocs.push(heredoc.heredoc)
      index = (heredoc?.next ?? heredocEnd) - 1
      // The jump passes over the delimiter word, which is never an operator, even where its last character is an escaped
      // `<`, `>`, or `|` (`<<E\>;`): a `&`, `|`, or `;` right after the word is a list operator, never part of a `<&`,
      // `>|`, `>;`, or `||` (fix brief 6, A2; fix brief 7, A2b).
      level.previous = ''
    } else if (character === '(') {
      // `!(` at a word start is a negated subshell, or an extended glob when extglob is on, which the text need not say.
      const kind: ParenKind = !WORD_PAREN_BEFORE.has(previous) ? 'command' : previous === '!' && previousStarted ? 'unsure' : 'word'
      // A case pattern's own opening parenthesis opens no subshell, and the pattern's `)` closes nothing.
      if (kind === 'command' && casePattern(level, index)) {
        finish(level, index, index + 1)
        level.wordStart = true
        continue
      }
      if (level.closer === ')') level.parens++
      // `((` is arithmetic, a command of its own, and `$((` arithmetic inside a word; neither runs the words in it.
      const arithmetic = text[index + 1] === '(' && (kind === 'command' || previous === '$') && arithmeticAt(text, index, meter)
      if (meter.characters < 0) return { ...limits, overBudget: true }
      level.opens.push({ kind, body: kind !== 'command' || arithmetic })
      level.wordStart = true
      if (kind !== 'command') {
        // A process substitution `<(` feeds the command it sits in the output of a command in the text.
        if (previous === '<') level.command.feed = true
        open(level, index, index + 1, wordBodyRuns(previous, previousStarted, kind, arithmetic))
      } else if (arithmetic) {
        finish(level, index, index + 1)
        level.interrupted.push(level.command)
        level.feedings.push(level.feeding)
        level.command = commandAt(index + 1, false, found)
        level.feeding = unfed()
      } else {
        finish(level, index, index + 1)
        level.feeding.compounds.push(mark())
        // `name()` defines a function, whose body runs wherever it is called.
        let after = index + 1
        while (text[after] === ' ' || text[after] === '\t') after++
        if (text[after] === ')') found.defines = true
      }
    } else if (character === ')' && casePattern(level, index)) {
      level.wordStart = afterClose('command')
      finish(level, index, index + 1)
      level.command.pattern = false
    } else if (character === ')') {
      if (level.closer === ')') level.parens--
      const opened = level.opens.pop()
      level.wordStart = afterClose(opened?.kind ?? 'command')
      if (opened?.body === true) close(level, index, index + 1)
      else {
        finish(level, index, index + 1)
        // A subshell's redirections follow its `)`, in the next command.
        if (opened !== undefined) level.feeding.closed = level.feeding.compounds.pop() ?? null
      }
    } else if ((character === '&' && (previous === '>' || previous === '<')) || (character === '|' && (previous === '>' || (previous === '&' && text[index - 2] === '>'))) || (character === ';' && previous === '>')) {
      // The `&` of `>&`, `<&`, or `N>&M` and the `|` of `>|` belong to a redirection operator, not a list operator, in
      // every POSIX shell, so they stay in the statement; a shell runs the command after the redirection (fix brief 5,
      // N2). So does the `|` of zsh's `>&|` and `>>&|` (fix brief 6, A4), and the `;` of ksh93's `>;word` and `<>;word`
      // (A5), each a syntax error in bash and dash, so keeping it there merges nothing they run. The `&` of `&>` and `&>>`
      // still ends one, as dash and POSIX sh read `a &>f b`: `a &` then `>f b` (fix brief 6, A1).
      level.wordStart = true
    } else if (BREAK_CHARACTERS.has(character)) {
      // bash, rbash, zsh, mksh, and ksh93 read that `&>` as one redirection of the command around it instead, its later
      // words that command's arguments, so the command it cut is read whole as well (Join), whatever the shell, as a bare
      // `>!` is read both ways (fix brief 7, A1b), and with a continuation between its `&` and `>`, which bash removes
      // first (fix brief 8, A4c). The `&` of `&&` and `|&` is that operator's.
      const join = character === '&' && text[pastContinuations(text, index + 1)] === '>' && previous !== '&' && previous !== '|' ? joinedBefore(level, index) : null
      level.wordStart = true
      finish(level, index, index + 1, join !== null)
      level.command.join = join
      // `;;`, `;&`, and `;;&` end a case clause: the next words are a pattern.
      if (character === ';' && (text[index + 1] === ';' || text[index + 1] === '&')) level.command.pattern = true
      // A `|` or `|&` pipes into what follows; `;`, `&`, `&&`, `||`, and a newline end the pipeline.
      if (character === '|' && text[index + 1] !== '|' && previous !== '|') pipeInto(level.feeding)
      else if (character !== '&' || previous !== '|') pipelineEnds(level.feeding)
      if (character === '\n' && heredocs.length > 0) {
        const bodies = heredocBodies({ text, from: index + 1, heredocs: heredocs.splice(0), found, flags, whole: mode.wholeBodies, depth, meter })
        meet(limits, bodies)
        index = bodies.next - 1
        level.start = index + 1
        level.command.from = index + 1
        level.command.statements = found.statements.length
        level.command.heads = found.heads.length
      }
    } else if (BLANKS.has(character) || OPERATOR_CHARACTERS.has(character)) {
      level.wordStart = true
      if (character === '<' && hereStringAt(text, index)) level.command.feed = true
    }
  }
  while (levels.length > (mode.heredocText ? 1 : 0)) {
    const level = levels.pop()!
    endLevel(level, text.length, text.length)
    // A body still open at the end continues the command of the level around it, which ends there too.
    if (levels.length > 0) levels.at(-1)!.command.from = text.length
  }
  return limits
}

/**
 * Where a comment starting at `from` ends: at the end of its line, or, inside a backtick body, at the closing backtick
 * if that comes first, since bash finds the body's end (the first backtick no backslash escapes) before it reads the
 * comment in it (slice 7i probes: `echo \`a # c\`; git push` ran the git push with no rule reading it).
 */
function commentEnd(text: string, from: number, inBacktick: boolean): number {
  if (!inBacktick) {
    const line = text.indexOf('\n', from)
    return line < 0 ? text.length : line
  }
  for (let index = from; index < text.length; index++) {
    const character = text[index]
    if (character === '\n' || character === '`') return index
    if (character === '\\') index++
  }
  return text.length
}

/**
 * `quoted` when any part of the delimiter word is quoted, so bash expands nothing in the body; `owner` the command it
 * feeds while that is read, and `command` that command's text once it ends (none while a body still open interrupts it).
 */
interface Heredoc { delimiter: string; tabs: boolean; quoted: boolean; owner: CommandText; command?: HeredocOwner }

/**
 * The text of a command that owns heredocs, whether its own input may come from the call's text (a substitution in an
 * unquoted body runs with that input), and, once asked, whether it may feed the bodies to a shell.
 */
interface HeredocOwner { text: string; fed: boolean; feeds?: boolean }

/** The heredoc whose `<<` ends just before `at` on the `owner` command: its delimiter word with quotes removed, and where the word ends. */
function heredocAt(text: string, at: number, owner: CommandText): { heredoc: Heredoc; next: number } | null {
  const word = heredocWordAt(text, at)
  return word === null ? null : { heredoc: { delimiter: word.delimiter, tabs: word.tabs, quoted: word.quoted, owner }, next: word.next }
}

/**
 * Where the text goes on past the line continuations at `at`: bash and dash remove a backslash-newline before they read
 * an operator or a word, so `&\<newline>>` is `&>` and `<\<newline><` is `<<` (fix brief 8, A4c).
 */
function pastContinuations(text: string, at: number): number {
  let index = at
  while (text[index] === '\\' && text[index + 1] === '\n') index += 2
  return index
}

/** Where a `<<` whose first `<` is at `at` ends, continuations removed (pastContinuations); -1 for none, or for a `<<<`. */
function heredocOperatorEnd(text: string, at: number): number {
  const second = pastContinuations(text, at + 1)
  if (text[second] !== '<') return -1
  return text[pastContinuations(text, second + 1)] === '<' ? -1 : second + 1
}

/** Whether the `<` at `at` opens a `<<<` here-string, continuations removed (pastContinuations). */
function hereStringAt(text: string, at: number): boolean {
  const second = pastContinuations(text, at + 1)
  return text[second] === '<' && text[pastContinuations(text, second + 1)] === '<'
}

/**
 * The delimiter word of a heredoc whose `<<` ends just before `at` (HeredocWord), and where the word ends; null for none.
 * A continuation before the `-`, among the blanks, or in the word is removed first, so it quotes nothing: under bash and
 * dash `<<E\<newline>OF` ends at an `EOF` line and expands its body (fix brief 8, A4c).
 */
function heredocWordAt(text: string, at: number): (HeredocWord & { next: number }) | null {
  let index = pastContinuations(text, at)
  const tabs = text[index] === '-'
  if (tabs) index++
  for (index = pastContinuations(text, index); text[index] === ' ' || text[index] === '\t'; index = pastContinuations(text, index + 1));
  const start = index
  let quote: string | null = null
  while (index < text.length) {
    const character = text[index]!
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") quote = character
    else if (character === '\\') index++
    else if (BLANKS.has(character) || /[;&|()<>]/.test(character)) break
    index++
  }
  const word = text.slice(start, index)
  const delimiter = unquote(word)
  // Each backslash with the character it escapes, paired from the left: one before a newline is a continuation.
  const quoted = /['"]/.test(word) || (word.match(/\\[\s\S]?/g) ?? []).some(pair => pair !== '\\\n')
  return delimiter === '' ? null : { delimiter, tabs, quoted, next: index }
}

/**
 * Each heredoc body after a line, up to each delimiter line, and where the text goes on. Every line is split as shell
 * text on its own, as a shell the body is fed to reads it, so a quote in a body ends with its line (slice 7b review
 * W7B-4). Under an unquoted delimiter bash also expands the body as heredoc text, `'` and `"` literal and every
 * `$(...)` and backtick body run, over lines and across them once its backslash-newline pairs are removed (slice 7e
 * review R7E-LW-2): each line is read that way too, and so is the whole body when `whole` allows. A quoted delimiter
 * expands nothing, so its lines are read as shell text only. Lines a backslash-newline joins for the shell the body
 * is fed to (`bash <<'EOF'`) are also read together as one statement, under either delimiter, so `git push \` then
 * `--force origin main` is a force push (slice 7f residual 1); the delimiter line still ends the body. Under an
 * unquoted delimiter the delimiter test runs on the body as bash reads it, after a backslash-newline joins a line to
 * the next, so a delimiter line that ends an odd run of backslashes is body text, not the end (slice 7f review
 * R7F-HR-2); and the body is also read as the fed shell receives it, `\\`, `\$` and an escaped backtick reduced and
 * the lines joined, so a substitution the raw body's backslashes hid is read (slice 7f review R7F-HR-1). When `whole`
 * allows, every body is also read whole as shell text, its quotes spanning lines, since a quoted body too may be fed
 * to a shell (`bash <<'EOF'`); a heredoc nested in a whole reading is read whole in turn, each level counting against
 * MAX_DEPTH, past which the call is left unread (slice 7f review R7F-HR-3, R7F-HR-4). `deep` says substitutions nested
 * past MAX_SUBSTITUTIONS in any of these readings (slice 7e review R7E-LW-1), `overDepth` that a nested whole reading
 * passed MAX_DEPTH. A `<<` that was no heredoc (`$((1<<2))`) only reads the lines after it one at a time.
 */
function heredocBodies(input: { text: string; from: number; heredocs: Heredoc[]; found: Found; flags: number; whole: boolean; depth: number; meter: CharacterMeter }): { next: number } & SplitLimits {
  let index = input.from
  const limits = noLimits()
  // Heredoc text expands for whatever command is fed the body, so it is read as the text around it is; the body read
  // whole as shell text is a safety net unless its command may feed it to a shell (a command a body still open cut is
  // taken to), and its lines read alone are always one.
  const read = (text: string, mode: SplitMode, depth: number, heredoc: Heredoc) => {
    if (limits.overBudget) return
    const runs = mode === HEREDOC_TEXT || (mode === SHELL_TEXT && feeds(heredoc.command))
    const fed = mode === HEREDOC_TEXT && (heredoc.command?.fed ?? true) ? FED : 0
    meet(limits, unquotedSplit(text, mode, depth, input.meter, input.found, (runs ? input.flags : input.flags | SAFETY_NET) | fed))
  }
  // Asked once per owning command; one a body still open interrupted, so never ended, is taken to feed a shell.
  const feeds = (owner: HeredocOwner | undefined): boolean => {
    if (owner === undefined) return true
    owner.feeds ??= input.found.feedsShell(owner.text)
    return owner.feeds
  }
  for (const heredoc of input.heredocs) {
    const bodyStart = index
    let bodyEnd = index
    // The lines joined so far, each without the backslash-newline that joins it to the next.
    let joined: string | null = null
    // Whether the previous physical line continues into this one, so this one is not tested as the delimiter.
    let continues = false
    while (index < input.text.length) {
      const newline = input.text.indexOf('\n', index)
      const lineEnd = newline < 0 ? input.text.length : newline
      const line = input.text.slice(index, lineEnd)
      index = lineEnd + 1
      const bodyLine = heredoc.tabs ? line.replace(/^\t+/, '') : line
      if (!continues && bodyLine === heredoc.delimiter) break
      bodyEnd = lineEnd
      read(line, SHELL_LINE, input.depth, heredoc)
      if (!heredoc.quoted) read(line, HEREDOC_TEXT, input.depth, heredoc)
      const joining = joiningBackslashes(bodyLine, heredoc.quoted)
      if (joined !== null || joining !== 0) {
        joined = (joined ?? '') + bodyLine.slice(0, bodyLine.length - joining)
        if (joining === 0) {
          read(joined, SHELL_LINE, input.depth, heredoc)
          joined = null
        }
      }
      // Only an odd run of backslashes joins a line to the next for the heredoc reader (bash does not halve `\\`
      // before it recognises the delimiter), and a quoted delimiter joins nothing.
      continues = !heredoc.quoted && trailingBackslashRun(bodyLine) % 2 === 1
    }
    // A run still open at the delimiter line, or at the end of the text, is read as it stands.
    if (joined !== null) read(joined, SHELL_LINE, input.depth, heredoc)
    if (bodyEnd > bodyStart && input.whole) {
      const body = input.text.slice(bodyStart, bodyEnd)
      if (!heredoc.quoted) read(body.replace(CONTINUED_LINE, joinLine), HEREDOC_TEXT, input.depth, heredoc)
      // The fed shell may run the whole body (`bash <<EOF`, `bash <<'EOF'`), its quotes spanning lines; an unquoted
      // body is read as the shell receives it, a quoted one as the raw body, and each nested heredoc read whole in
      // turn counts one level against MAX_DEPTH, past which the call is left unread (slice 7f review R7F-HR-3, R7F-HR-4).
      if (input.depth >= MAX_DEPTH) limits.overDepth = true
      else {
        // A `<<-` delimiter strips leading tabs before the shell receives the body: of every line under a quoted
        // delimiter, of each logical line under an unquoted one (fedShellView). With no backslash the two agree.
        const fed = heredoc.quoted || !body.includes('\\') ? (heredoc.tabs ? body.replace(/^\t+/gm, '') : body) : fedShellView(body, heredoc.tabs)
        read(fed, SHELL_TEXT, input.depth + 1, heredoc)
      }
    }
  }
  return { next: Math.min(index, input.text.length), ...limits }
}

/** How many backslashes end a body line, so a caller can tell an odd run (a continuation) from an even one. */
function trailingBackslashRun(line: string): number {
  let count = 0
  while (count < line.length && line[line.length - 1 - count] === '\\') count++
  return count
}

/**
 * How many backslashes at the end of a body line join it to the next, as the shell the body is fed to reads it, or 0.
 * An odd run ends in a backslash-newline. Under an unquoted delimiter bash also turns each `\\` into `\` before that
 * shell reads the body, so a run of 2 (mod 4) ends in one too, and those two backslashes go with the newline.
 */
function joiningBackslashes(line: string, quoted: boolean): number {
  const count = trailingBackslashRun(line)
  if (count % 2 === 1) return 1
  return !quoted && count % 4 === 2 ? 2 : 0
}

/**
 * A heredoc body under an unquoted delimiter as the command it is fed to receives it: a backslash before `$`, a
 * backtick or a backslash leaves only that character, a backslash before a newline removes both (the lines join), and
 * every other backslash stays. One left-to-right pass, so three trailing backslashes are one backslash and a
 * continuation, and four are two literal backslashes. Under `<<-` (`tabs`) bash strips the leading tabs of each line
 * it reads, and a line a continuation joins on is part of the line before it, so it keeps its tabs (slice 7h probes:
 * five backslashes before a newline under `<<-EOF` ran `\` and `mark`, where stripping every line read `\mark`).
 */
function fedShellView(body: string, tabs: boolean): string {
  let view = ''
  let lineStart = true
  for (let index = 0; index < body.length; index++) {
    if (lineStart && tabs) while (body[index] === '\t') index++
    lineStart = false
    if (index >= body.length) break
    const character = body[index]!
    if (character === '\n') lineStart = true
    if (character === '\\' && index + 1 < body.length) {
      const next = body[index + 1]!
      if (next === '$' || next === '`' || next === '\\') {
        view += next
        index++
        continue
      }
      if (next === '\n') {
        index++
        continue
      }
    }
    view += character
  }
  return view
}

/**
 * A backtick body as bash's parser keeps it while it looks for the closing backtick: it pairs the backslashes, and a
 * backslash-newline whose backslash ends an odd run is a line continuation it removes, single quotes in the body or
 * not; an even run is escaped backslashes, and the newline stays. So three backslashes and a newline inside `gi` and
 * `t` leave `gi\\t`, which backtickView makes `gi\t`, and bash runs git (the 7h to 7k review).
 */
function joinedBacktick(body: string): string {
  if (!body.includes('\\\n')) return body
  const parts: string[] = []
  let from = 0
  let run = 0
  for (let index = 0; index < body.length; index++) {
    const character = body[index]
    if (character === '\n' && run % 2 === 1) {
      parts.push(body.slice(from, index - 1))
      from = index + 1
    }
    run = character === '\\' ? run + 1 : 0
  }
  parts.push(body.slice(from))
  return parts.join('')
}

/**
 * A backtick body as bash runs it: before it parses the body as commands, bash removes a backslash before `\`, a
 * backtick or `$`, and before `"` too when double quotes hold the body; every other backslash stays (de_backslash). One
 * left-to-right pass, so `\\--force` becomes `\--force`, which runs `--force`, and four backslashes leave two.
 */
function backtickView(body: string, doubleQuoted: boolean): string {
  let view = ''
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!
    const next = body[index + 1]
    if (character === '\\' && (next === '\\' || next === '`' || next === '$' || (doubleQuoted && next === '"'))) {
      view += next
      index++
      continue
    }
    view += character
  }
  return view
}

/** A backslash and the character it escapes: a newline after it is removed with it, as bash joins a heredoc body's lines. */
const CONTINUED_LINE = /\\[\s\S]/g
const joinLine = (escape: string) => (escape === '\\\n' ? '' : escape)

/** A word of shell text as written (`raw`, quotes kept) and as the command receives it (`word`, quotes removed). */
export interface ShellToken {
  raw: string
  word: string
}

/** A run of line continuations between words, which bash removes and which is no word. */
const CONTINUATIONS_ONLY = /^(?:\\\n)+$/

/** Text as a shell would split it into words (wordEnd), each as written and as the command receives it. */
export function shellTokens(text: string): ShellToken[] {
  return shellTokensUpTo(text, Number.POSITIVE_INFINITY).tokens
}

/**
 * The first words of text as a shell would split it, at most `limit` of them; `more` says whether a word was left
 * unread. Reads only as far as it returns.
 */
export function shellTokensUpTo(text: string, limit: number): { tokens: ShellToken[]; more: boolean } {
  const tokens: ShellToken[] = []
  let index = 0
  while (index < text.length) {
    if (BLANKS.has(text[index]!)) {
      index++
      continue
    }
    // A word with no quote, escape, or expansion in it ends at the next blank and is its own value.
    const code = text.charCodeAt(index)
    const run = code >= 128 || WORD_SPECIAL[code] === 0 ? runEnd(text, index, WORD_SPECIAL) : -1
    const plain = run >= 0 && (run >= text.length || BLANKS.has(text[run]!))
    const end = plain ? run : wordEnd(text, index)
    const raw = text.slice(index, end)
    index = end
    if (!plain && CONTINUATIONS_ONLY.test(raw)) continue
    if (tokens.length >= limit) return { tokens, more: true }
    tokens.push({ raw, word: plain ? raw : unquote(raw) })
  }
  return { tokens, more: false }
}

/**
 * What a reading of one word is inside, innermost last: the word itself, a double-quoted string, the braces of a
 * parameter expansion, a backtick body, or the body of a command or process substitution (BodyReading).
 */
type WordPart = 'word' | 'double' | 'brace' | 'backtick' | BodyReading

/**
 * A `$(...)`, `<(...)` or `>(...)` body as bash parses it while it looks for the closing parenthesis: as commands, so a
 * parenthesis a quote, a comment, a heredoc body, or a nested body holds closes nothing, nor does one that ends a case
 * pattern. `parens` holds each parenthesis open in it, true for one inside a word (`@(`, `a=(`), after whose `)` the word
 * goes on. `inWord` says a word is being read; `command` that the next word starts a command, where `case` and the words
 * before a command are reserved; `subject` counts the words a `case` still awaits (its word, then `in`); `pattern` that
 * the words are case patterns, so a `)` with no parenthesis open ends one; `heredocs` the heredocs whose bodies start
 * after the next newline. A `$((` body is read as arithmetic: only its quotes, its expansions, and its parentheses count.
 */
interface BodyReading {
  parens: boolean[]
  arithmetic: boolean
  inWord: boolean
  command: boolean
  subject: number
  pattern: boolean
  heredocs: HeredocWord[]
}

/** Characters that end a word as bash's reader ends one outside quotes: a blank or an operator character. */
const WORD_ENDS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])

/** Characters each part acts on; any other one is passed over with the run it begins. */
const specials = (characters: string): Uint8Array => {
  const table = new Uint8Array(128)
  for (const character of characters) table[character.charCodeAt(0)] = 1
  return table
}
const WORD_SPECIAL = specials(' \t\n\\\'"$`<>')
const DOUBLE_SPECIAL = specials('\\"$`')
const BRACE_SPECIAL = specials('\\\'"$`}')
const BACKTICK_SPECIAL = specials('\\`')
const ARITHMETIC_SPECIAL = specials('\\\'"$`()')
const BODY_SPECIAL = specials(' \t\n\\\'"$`<>;&|()')

/** Where the run of characters a part passes over, starting with the one at `index`, ends. */
function runEnd(text: string, index: number, special: Uint8Array): number {
  let at = index + 1
  while (at < text.length) {
    const code = text.charCodeAt(at)
    if (code < 128 && special[code] === 1) break
    at++
  }
  return at
}

/** Where a single-quoted or `$'...'` run starting at `index` ends, past its closing quote, or null when none starts there. */
function literalQuoteEnd(text: string, index: number): number | null {
  if (text[index] === "'") {
    const close = text.indexOf("'", index + 1)
    return close < 0 ? text.length : close + 1
  }
  if (text[index] !== '$' || text[index + 1] !== "'") return null
  let at = index + 2
  while (at < text.length && text[at] !== "'") at += text[at] === '\\' ? 2 : 1
  return Math.min(at + 1, text.length)
}

/**
 * The part an expansion opening at `index` starts and where its text begins: `$((` (arithmetic), `$(`, `${`, a
 * backtick, and, where `processes` allows (outside double quotes and braces), `<(` and `>(`. Null for none.
 */
function expansionAt(text: string, index: number, processes: boolean): { part: WordPart; next: number } | null {
  const character = text[index]
  if (character === '`') return { part: 'backtick', next: index + 1 }
  if (character === '$') {
    if (text[index + 1] === '{') return { part: 'brace', next: index + 2 }
    if (text[index + 1] !== '(') return null
    const arithmetic = text[index + 2] === '('
    return { part: bodyReading(arithmetic), next: index + (arithmetic ? 3 : 2) }
  }
  if (processes && (character === '<' || character === '>') && text[index + 1] === '(') return { part: bodyReading(false), next: index + 2 }
  return null
}

const bodyReading = (arithmetic: boolean): BodyReading =>
  ({ parens: arithmetic ? [true] : [], arithmetic, inWord: false, command: true, subject: 0, pattern: false, heredocs: [] })

/**
 * Where the word starting at `from` ends, as bash reads it: at a space, tab, or newline outside every quote and every
 * expansion the word holds. Single quotes, `$'...'` (whose backslash escapes its quote), and a backslash keep text as
 * written; a double quote runs to the double quote that closes it. Each expansion starts a fresh quoting context, inside
 * double quotes as outside, and runs to the end bash finds for it: a `$(...)`, `<(...)` or `>(...)` body to its closing
 * parenthesis (BodyReading), a `${...}` to its closing brace (quotes inside it nest, a bare `{` does not, as bash 5.2
 * reads it), and a backtick body to the next backtick no backslash escapes (quotes inside it nest nothing, as bash finds
 * it). So `x="$(echo "a b")"` is one word and the word after it is the command (a probe under bash 5.2: the reading
 * that ended the double-quoted word at the inner quote read the command as `b)` while bash ran git push). An unquoted
 * `<` or `>` ends a word too, unless it opens a process substitution or follows the descriptor digits or `{name}` that
 * are the whole word so far, so `rm>/dev/null -rf x` is `rm`, `>/dev/null`, `-rf`, and `x` (fix brief 6, A3, A4). An unclosed quote or
 * expansion runs to the end of the text.
 */
function wordEnd(text: string, from: number): number {
  return partEnd(text, from, 'word')
}

/** What may stand before a redirection operator in the same word: the descriptor it redirects (`2>`), or a bash named one (`{fd}>`). */
const REDIRECTION_PREFIX = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/

/** The characters of a redirection operator, shared with the grammar's operators (command-forms.ts REDIRECTION). */
const OPERATOR_CHARACTER = /[<>&|!;]/

/**
 * A word as the redirection grammar reads it (command-forms.ts REDIRECTION, BARE_REDIRECTION, and takesNextWord): its
 * leading operator span, the descriptor digits or `{name}` and then the operator characters, with each line continuation
 * in it removed, as bash and dash remove a backslash-newline before they read words (`>\<newline>` is `>`, `2\<newline>>`
 * is `2>`, `{f\<newline>d}>` is `{fd}>`), and the rest of the word as written. A pair is read from the left, so an
 * escaped backslash before a newline stays (fix brief 7, A4b).
 */
export function joinedOperator(raw: string): string {
  if (!raw.includes('\\\n')) return raw
  let span = ''
  type State = 'start' | 'digits' | 'name' | 'named' | 'operator'
  let state: State = 'start'
  let at = 0
  while (at < raw.length) {
    if (raw[at] === '\\' && raw[at + 1] === '\n') {
      at += 2
      continue
    }
    const character = raw[at]!
    const next: State | null = state === 'name' ? (/\w/.test(character) ? 'name' : character === '}' ? 'named' : null)
      : OPERATOR_CHARACTER.test(character) ? 'operator'
        : (state === 'start' || state === 'digits') && /\d/.test(character) ? 'digits'
          : state === 'start' && character === '{' ? 'name'
            : null
    if (next === null) break
    span += character
    state = next
    at++
  }
  return span + raw.slice(at)
}

/**
 * Where `first`, whose text starts at `from`, ends: past its closer, at the blank that ends a word, at an unquoted `<` or
 * `>` that ends one, or at the end of the text.
 */
function partEnd(text: string, from: number, first: WordPart): number {
  const parts: WordPart[] = [first]
  let index = from
  while (index < text.length) {
    const part = parts[parts.length - 1]!
    const character = text[index]!
    // The innermost part closes at `index` when `closes` is set: the reading goes on in the one around it, or returns.
    let closes = false
    let opened: { part: WordPart; next: number } | null = null
    // A command body reads its own escapes (bodyStep); every other part passes over the escaped character.
    if (character === '\\' && typeof part === 'object' && !part.arithmetic) index = bodyStep(text, index, part).index
    else if (character === '\\') index += 2
    else if (part === 'word') {
      if (character === ' ' || character === '\t' || character === '\n') return index
      // An unquoted `<` or `>` that opens no process substitution ends the word, as bash's reader ends one, and starts a
      // redirection; descriptor digits belong to it only when they are the whole word so far (fix brief 6, A3). One a
      // whole-command reading shows with its body cut (`BASH_ENV=<$() bash`) is a process substitution too.
      // bash removes a line continuation before it reads the word, so one among the digits or the operator characters is
      // no part of either (`2\<newline>>`, `>\<newline>>`; fix brief 7, A4b).
      if ((character === '<' || character === '>') && text[index + 1] !== '(' && !text.startsWith(SUBSTITUTED, index + 1)) {
        if (index > from && !REDIRECTION_PREFIX.test(text.slice(from, index).replace(CONTINUED_LINE, joinLine))) return index
        while (text[index] === '<' || text[index] === '>' || (text[index] === '\\' && text[index + 1] === '\n')) index += text[index] === '\\' ? 2 : 1
        continue
      }
      const quoted = character === "'" || character === '$' ? literalQuoteEnd(text, index) : null
      if (quoted !== null) index = quoted
      else if (character === '"') opened = { part: 'double', next: index + 1 }
      else if ((opened = expansionAt(text, index, true)) === null) index = runEnd(text, index, WORD_SPECIAL)
    } else if (part === 'double') {
      if (character === '"') closes = true
      else if ((opened = expansionAt(text, index, false)) === null) index = runEnd(text, index, DOUBLE_SPECIAL)
    } else if (part === 'brace') {
      const quoted = character === "'" || character === '$' ? literalQuoteEnd(text, index) : null
      if (character === '}') closes = true
      else if (quoted !== null) index = quoted
      else if (character === '"') opened = { part: 'double', next: index + 1 }
      else if ((opened = expansionAt(text, index, false)) === null) index = runEnd(text, index, BRACE_SPECIAL)
    } else if (part === 'backtick') {
      if (character === '`') closes = true
      else index = runEnd(text, index, BACKTICK_SPECIAL)
    } else if (part.arithmetic) {
      const quoted = character === "'" || character === '$' ? literalQuoteEnd(text, index) : null
      if (quoted !== null) index = quoted
      else if (character === '"') opened = { part: 'double', next: index + 1 }
      else if (character === '(') {
        part.parens.push(true)
        index++
      } else if (character === ')') {
        if (part.parens.pop() === undefined) closes = true
        else index++
      } else if ((opened = expansionAt(text, index, false)) === null) index = runEnd(text, index, ARITHMETIC_SPECIAL)
    } else {
      const next = bodyStep(text, index, part)
      opened = next.opened ?? null
      closes = next.closes === true
      if (!opened && !closes) index = next.index
    }
    if (opened) {
      parts.push(opened.part)
      index = opened.next
    } else if (closes) {
      parts.pop()
      index++
      if (parts.length === 0) return index
    }
  }
  return text.length
}

/**
 * One step of a command body (BodyReading) at `index`: where the reading goes on, the part an expansion or a double
 * quote opens there, or that the body's closing parenthesis is there.
 */
function bodyStep(text: string, index: number, body: BodyReading): { index: number; opened?: { part: WordPart; next: number }; closes?: true } {
  const character = text[index]!
  if (character === ' ' || character === '\t') {
    body.inWord = false
    return { index: index + 1 }
  }
  if (character === '\n') {
    body.inWord = false
    if (!body.pattern) body.command = true
    return { index: body.heredocs.length > 0 ? heredocBodiesEnd(text, index + 1, body.heredocs.splice(0)) : index + 1 }
  }
  if (character === '#' && !body.inWord) {
    const line = text.indexOf('\n', index)
    return { index: line < 0 ? text.length : line }
  }
  if (character === '\\' && text[index + 1] === '\n') return { index: index + 2 }
  if (character === ';' || character === '&' || character === '|') {
    body.inWord = false
    // `;;`, `;&`, and `;;&` end a case clause, so a case pattern comes next; a `|` inside a pattern separates two.
    if (character === ';' && (text[index + 1] === ';' || text[index + 1] === '&')) {
      body.pattern = true
      body.command = false
      return { index: index + (text[index + 1] === ';' && text[index + 2] === '&' ? 3 : 2) }
    }
    if (!(character === '|' && body.pattern)) body.command = true
    return { index: index + 1 }
  }
  if ((character === '<' || character === '>') && text[index + 1] !== '(') {
    body.inWord = false
    body.command = false
    if (character === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      const word = heredocWordAt(text, index + 2)
      if (word) body.heredocs.push(word)
      return { index: word?.next ?? index + 2 }
    }
    const operator = /^(?:<<<|<>|>>|[<>][&|])/.exec(text.slice(index, index + 3))
    return { index: index + (operator?.[0].length ?? 1) }
  }
  if (character === '(') {
    // Inside a word a parenthesis belongs to it (an extended glob, an array). At a case pattern's start it is the
    // pattern's own, read as one a subshell opens: its `)` closes it, and the patterns read on to the next `)`, `;;` or
    // `esac`, which leaves the reading where the pattern's end would.
    body.parens.push(body.inWord)
    if (!body.inWord) body.command = true
    return { index: index + 1 }
  }
  if (character === ')') {
    const word = body.parens.pop()
    if (word !== undefined) {
      body.inWord = word
      if (!word) body.command = false
      return { index: index + 1 }
    }
    if (!body.pattern) return { index, closes: true }
    body.pattern = false
    body.command = true
    body.inWord = false
    return { index: index + 1 }
  }
  if (!body.inWord) startWord(text, index, body)
  body.inWord = true
  if (character === '\\') return { index: index + 2 }
  const quoted = literalQuoteEnd(text, index)
  if (quoted !== null) return { index: quoted }
  if (character === '"') return { index, opened: { part: 'double', next: index + 1 } }
  const opened = expansionAt(text, index, true)
  if (opened) return { index, opened }
  return { index: runEnd(text, index, BODY_SPECIAL) }
}

/**
 * What a word starting at `index` of a command body changes, as leadingWords reads the same words of a statement: `case`
 * at a command's start awaits its word and `in`, after which its patterns come; `esac` ends them; and the reserved words
 * before a command (`if`, `then`, `do`, `!`, ...) keep the next word at a command's start.
 */
function startWord(text: string, index: number, body: BodyReading): void {
  let end = index
  while (end < text.length && end - index < 6 && !WORD_ENDS.has(text[end]!)) end++
  const word = end >= text.length || WORD_ENDS.has(text[end]!) ? text.slice(index, end) : ''
  if (body.subject === 1) {
    body.subject = 2
    body.command = false
  } else if (body.subject === 2) {
    body.subject = 0
    body.pattern = word === 'in'
    body.command = false
  } else if (body.pattern) {
    if (word === 'esac') body.pattern = false
    body.command = false
  } else if (body.command) {
    body.subject = word === 'case' ? 1 : 0
    body.command = word !== 'case' && ((COMPOUND_OPENERS.has(word) && word !== 'for' && word !== 'select') || BEFORE_A_COMMAND.has(word))
  }
}

/** A heredoc's delimiter word, quotes removed, whether any part of it was quoted, and whether `<<-` strips leading tabs. */
interface HeredocWord { delimiter: string; tabs: boolean; quoted: boolean }

/** Where the bodies of `heredocs`, the first starting at `from`, end: past each one's delimiter line, as heredocBodies finds it. */
function heredocBodiesEnd(text: string, from: number, heredocs: readonly HeredocWord[]): number {
  let index = from
  for (const heredoc of heredocs) {
    let continues = false
    while (index < text.length) {
      const newline = text.indexOf('\n', index)
      const lineEnd = newline < 0 ? text.length : newline
      const line = text.slice(index, lineEnd)
      index = lineEnd + 1
      const bodyLine = heredoc.tabs ? line.replace(/^\t+/, '') : line
      if (!continues && bodyLine === heredoc.delimiter) break
      continues = !heredoc.quoted && trailingBackslashRun(bodyLine) % 2 === 1
    }
  }
  return Math.min(index, text.length)
}

/** The characters with which an expansion starts; a word holding none of them holds none. */
const EXPANSION_CHARACTERS = /[$`*?[{~]/

/**
 * Whether a word as written holds an expansion the shell makes before the command receives it, so its value is not the
 * text Buckle reads: a `$` (other than `$'`) or a backtick outside single quotes, and outside any quotes a glob
 * character (`*`, `?`, `[`), a brace expansion, a leading `~`, or a leading `=` before a name, which zsh's EQUALS option
 * (on by default) turns into the path of the named command (`=rm`). Single quotes, `$'...'`, and a backslash keep text
 * as written; an `=` later in a word (an assignment, `--opt=value`) is no expansion.
 */
export function holdsExpansion(raw: string): boolean {
  if (raw.length > 1 && raw[0] === '=') return true
  if (!EXPANSION_CHARACTERS.test(raw)) return false
  let quote: null | "'" | "$'" | '"' = null
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!
    if (quote === "'") {
      if (character === "'") quote = null
    } else if (quote === "$'") {
      if (character === '\\') index++
      else if (character === "'") quote = null
    } else if (character === '\\') index++
    else if (quote === '"' && character === '"') quote = null
    else if (character === '$' && quote === null && raw[index + 1] === "'") {
      quote = "$'"
      index++
    } else if (character === '$' || character === '`') return true
    else if (quote === null && (character === "'" || character === '"')) quote = character
    else if (quote === null && ('*?['.includes(character) || (character === '~' && index === 0))) return true
    // A brace expansion needs a comma or a `..` sequence after its `{`; `{}` alone is a word, as find hands it on.
    else if (quote === null && character === '{' && /,|\.\./.test(raw.slice(index + 1))) return true
  }
  return false
}

/** What the expansions a word holds may make of it (expansionShape). */
export interface ExpansionShape {
  /** The word may become several words, or none. */
  splits: boolean
  /** The word's own text before its first expansion, quotes removed, which the expansion cannot change. */
  prefix: string
}

/**
 * How the expansions a word as written holds (holdsExpansion) may change it. Outside double quotes a `$` or a backtick
 * is split on blanks and globbed, and a pattern or a brace expansion may name several words, so the word may become
 * several or none; inside them each is one word, but for `"$@"` and an array's elements (`"${a[@]}"`, `"${@:2}"`,
 * `"${!a[@]}"`), which are a word each, so any `@` in a `${...}` but its length counts as several. A leading tilde names
 * one directory, and a process substitution and zsh's `=name` one path: none of them splits. `prefix` is the text before the first expansion.
 * A word in which no expansion is found is read as one that may split, from its start.
 */
export function expansionShape(raw: string): ExpansionShape {
  let quoted = false
  let first = -1
  let splits = false
  const met = (at: number, several: boolean) => {
    if (first < 0) first = at
    splits ||= several
  }
  for (let index = 0; index < raw.length && !splits;) {
    const character = raw[index]!
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '"') {
      quoted = !quoted
      index++
      continue
    }
    const literal = quoted ? null : literalQuoteEnd(raw, index)
    if (literal !== null) {
      index = literal
      continue
    }
    // A process substitution, or one a whole-command reading shows with its body cut (`<$()`), names one path.
    const process = !quoted && (character === '<' || character === '>') && (raw[index + 1] === '(' || raw.startsWith('$(', index + 1))
    if (character === '$' || character === '`' || process) {
      const at = process && raw[index + 1] === '$' ? index + 1 : index
      const opened = expansionAt(raw, at, !quoted)
      const end = opened ? partEnd(raw, opened.next, opened.part) : parameterEnd(raw, at + 1)
      const text = raw.slice(index, end)
      met(index, quoted ? text === '$@' || (text.startsWith('${') && !text.startsWith('${#') && text.includes('@')) : !process)
      index = Math.max(end, index + 1)
      continue
    }
    if (!quoted && ('*?['.includes(character) || (character === '{' && /,|\.\./.test(raw.slice(index + 1))))) met(index, true)
    else if (!quoted && (character === '~' || (character === '=' && raw.length > 1)) && index === 0) met(index, false)
    index++
  }
  return first < 0 ? { splits: true, prefix: '' } : { splits, prefix: unquote(raw.slice(0, first)) }
}

/** Where a parameter named after a `$` at `from - 1` ends: past a name, or past one digit or special parameter. */
function parameterEnd(raw: string, from: number): number {
  if (/[A-Za-z_]/.test(raw[from] ?? '')) {
    let end = from + 1
    while (end < raw.length && /[A-Za-z0-9_]/.test(raw[end]!)) end++
    return end
  }
  return /[0-9@*#?$!-]/.test(raw[from] ?? '') ? from + 1 : from
}

/** Text as a shell would split it into words, roughly: whitespace separates, quotes and backslashes are removed. */
export function shellWords(text: string): string[] {
  return shellTokens(text).map(token => token.word)
}

/**
 * Quote removal as a shell does it: single quotes keep everything; in double quotes a backslash escapes `"`, `\\`,
 * `$` and a backtick; in `$'...'` a backslash escape is decoded (`\'`, `\n`, `\x2d`); outside, a backslash escapes
 * any character, and one with nothing after it stays. Outside single quotes a backslash-newline is a line
 * continuation and leaves nothing. An expansion (expansionAt), in double quotes or not, is kept as written, its own
 * quotes with it: its value exists only once the shell has run, and its text is read as a body of its own elsewhere.
 */
function unquote(raw: string): string {
  let word = ''
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!
    const expansion = character === '$' || character === '`' || character === '<' || character === '>' ? expansionAt(raw, index, true) : null
    if (expansion) {
      const end = partEnd(raw, expansion.next, expansion.part)
      word += raw.slice(index, end)
      index = end - 1
    } else if (character === '$' && raw[index + 1] === "'") {
      const decoded = ansiC(raw, index + 2)
      word += decoded.text
      index = decoded.end
    } else if (character === "'") {
      const end = raw.indexOf("'", index + 1)
      const stop = end < 0 ? raw.length : end
      word += raw.slice(index + 1, stop)
      index = stop
    } else if (character === '"') {
      const quoted = doubleQuoted(raw, index + 1)
      word += quoted.text
      index = quoted.end
    } else if (character === '\\') {
      index++
      // A backslash that ends the text escapes nothing, and bash keeps it (`bash -c 'echo a\'` prints `a\`).
      if (index >= raw.length) word += '\\'
      else if (raw[index] !== '\n') word += raw[index]
    } else word += character
  }
  return word
}

const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`'])

/**
 * The text of a double-quoted run whose body starts at `from`, escapes removed, copied a run at a time, and the index of
 * its closing quote. An expansion in it is copied as written (unquote).
 */
function doubleQuoted(raw: string, from: number): { text: string; end: number } {
  let text = ''
  let run = from
  let index = from
  for (; index < raw.length && raw[index] !== '"'; index++) {
    const expansion = raw[index] === '$' || raw[index] === '`' ? expansionAt(raw, index, false) : null
    if (expansion) {
      index = partEnd(raw, expansion.next, expansion.part) - 1
      continue
    }
    if (raw[index] !== '\\') continue
    const escaped = raw[index + 1] ?? ''
    // A backslash before any other character stays, with that character, in the run; a backslash-newline leaves nothing.
    if (DOUBLE_QUOTE_ESCAPES.has(escaped) || escaped === '\n') {
      text += raw.slice(run, index) + (escaped === '\n' ? '' : escaped)
      run = index + 2
    }
    index++
  }
  return { text: text + raw.slice(run, Math.min(index, raw.length)), end: index }
}

const ANSI_C_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
const HEX_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 }

/** The text of a `$'...'` run whose body starts at `from`, escapes decoded as bash decodes them, and the index of its closing quote. */
function ansiC(raw: string, from: number): { text: string; end: number } {
  let text = ''
  let index = from
  for (; index < raw.length && raw[index] !== "'"; index++) {
    if (raw[index] !== '\\' || index + 1 >= raw.length) {
      text += raw[index]
      continue
    }
    const escape = raw[index + 1]!
    if (Object.hasOwn(ANSI_C_ESCAPES, escape)) {
      text += ANSI_C_ESCAPES[escape]
      index++
      continue
    }
    const width = escape >= '0' && escape <= '7' ? 3 : HEX_DIGITS[escape]
    const digits = width === undefined ? '' : digitRun(raw, escape >= '0' && escape <= '7' ? index + 1 : index + 2, width, escape >= '0' && escape <= '7' ? /[0-7]/ : /[0-9a-fA-F]/)
    if (digits === '') {
      text += `\\${escape}`
      index++
      continue
    }
    const code = Number.parseInt(digits, escape >= '0' && escape <= '7' ? 8 : 16)
    text += code <= 0x10ffff ? String.fromCodePoint(code) : ''
    index += digits.length + (escape >= '0' && escape <= '7' ? 0 : 1)
  }
  return { text, end: index }
}

function digitRun(raw: string, from: number, width: number, digit: RegExp): string {
  let end = from
  while (end < raw.length && end - from < width && digit.test(raw[end]!)) end++
  return raw.slice(from, end)
}

/** A command word as the rules compare it: its basename, lowercased, so a path to a binary is the binary. */
export function baseCommand(command: string): string {
  const withoutDirectory = command.split(/[\\/]/).pop() ?? command
  return withoutDirectory.toLowerCase()
}
