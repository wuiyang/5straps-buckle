import { createHash } from 'node:crypto'
import { redactShownText } from './redact.js'

/** Interpreters whose positional is a script body rather than an argument list. */
export const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

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
 * A command as a person reads it: each word redacted as the shown arguments are (redactShownText), then
 * quoted as a POSIX shell would need it, so its boundaries show (`rm -f 'a b'` is not `rm -f a b`).
 * Display only: the grant matches on argvIdentity.
 */
export function shownCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((word, index) => shellQuote(redactShownText(word), index === 0)).join(' ')
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

function shellQuote(word: string, first: boolean): string {
  if ((first ? PLAIN_WORD : PLAIN_ARGUMENT).test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** `bash -c "..."` and its equivalents, whose script body hides the real command from a word glob. */
export function isShellWrapper(argv: ParsedArgv): boolean {
  return SHELL_COMMANDS.has(argv.command) && argv.shortFlags.has('c')
}

/**
 * The statements of a shell script body, split where a shell would start a new command, so a
 * pattern written for a command line also meets `curl` inside `bash -c "... | curl ..."`. A single
 * `&`, a subshell's parentheses, `$(` and a backtick start one too (`true & git push -f`, `$(git clean -f)`).
 * Splitting is textual, so a separator inside quotes splits too: that only adds candidates to judge.
 */
export function shellStatements(argv: ParsedArgv): string[] {
  if (!SHELL_COMMANDS.has(argv.command)) return []
  return argv.positionals
    .join('\n')
    .split(/\n|;|&|\||`|\$\(|\(|\)/)
    .map(statement => statement.trim())
    .filter(Boolean)
}

/** Splits on whitespace, keeping a quoted run together and dropping the quotes. */
const STATEMENT_WORD = /"[^"]*"|'[^']*'|\S+/g

/** Text as a shell would split it into words, roughly: whitespace separates, a quoted run stays one word. */
export function shellWords(text: string): string[] {
  return (text.match(STATEMENT_WORD) ?? []).map(unquote)
}

function unquote(word: string): string {
  const quote = word.charAt(0)
  if (word.length >= 2 && (quote === '"' || quote === "'") && word.endsWith(quote)) return word.slice(1, -1)
  return word
}

/** A command word as the rules compare it: its basename, lowercased, so a path to a binary is the binary. */
export function baseCommand(command: string): string {
  const withoutDirectory = command.split(/[\\/]/).pop() ?? command
  return withoutDirectory.toLowerCase()
}
