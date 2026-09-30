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
 * `--name=value` forms, and the ones with no value such as `-p`, `--no-pager` or `--bare`), and a bare `--`
 * ends them, so the word after it is the subcommand. An unknown option is taken to have no value.
 */
export function gitInvocation(args: readonly string[]): { subcommand: string | null; args: string[] } {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === '--') return { subcommand: args[index + 1] ?? null, args: args.slice(index + 2) }
    if (!word.startsWith('-') || word === '-') return { subcommand: word, args: args.slice(index + 1) }
    if (GIT_OPTIONS_WITH_VALUE.has(word)) index++
  }
  return { subcommand: null, args: [] }
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
 * pattern written for a command line also meets `curl` inside `bash -c "... | curl ..."`.
 */
export function shellStatements(argv: ParsedArgv): string[] {
  if (!SHELL_COMMANDS.has(argv.command)) return []
  return argv.positionals
    .join('\n')
    .split(/\n|;|&&|\|\||\|/)
    .map(statement => statement.trim())
    .filter(Boolean)
}

/** Splits on whitespace, keeping a quoted run together and dropping the quotes. */
const STATEMENT_WORD = /"[^"]*"|'[^']*'|\S+/g

/**
 * One statement of a script body as words, normalised like `parseArgv` does, so a command glob
 * judges what runs inside `bash -c` the way it judges an argument list.
 */
export function statementWords(statement: string): string[] {
  const words = (statement.match(STATEMENT_WORD) ?? []).map(unquote)
  const [command, ...rest] = words
  if (command === undefined) return []
  return [baseCommand(command), ...rest]
}

function unquote(word: string): string {
  const quote = word.charAt(0)
  if (word.length >= 2 && (quote === '"' || quote === "'") && word.endsWith(quote)) return word.slice(1, -1)
  return word
}

function baseCommand(command: string): string {
  const withoutDirectory = command.split(/[\\/]/).pop() ?? command
  return withoutDirectory.toLowerCase()
}
