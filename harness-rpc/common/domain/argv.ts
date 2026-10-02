import { createHash } from 'node:crypto'
import { redactCredentials } from '@5straps/runtime'

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
 * A command as a person reads it: each word redacted by its context (owner decision D21), the script body of a shell's
 * `-c` as a shell body and every other word as one word, then quoted as a POSIX shell would need it, so its
 * boundaries show (`rm -f 'a b'` is not `rm -f a b`). Display only: the grant matches on argvIdentity.
 */
export function shownCommand(command: string, args: readonly string[]): string {
  const words = [command, ...args]
  const bodies = shellBodyIndexes(words)
  return words.map((word, index) => shellQuote(redactCredentials(word, bodies.has(index) ? 'shell' : 'word'), index === 0)).join(' ')
}

/** Shell options before the script that take the next word as their value (`-o pipefail`, `--rcfile <file>`). */
const SHELL_VALUE_OPTIONS = new Set(['o', 'O'])
const SHELL_LONG_VALUE_OPTIONS = new Set(['--rcfile', '--init-file'])

/**
 * Which words of a command line are a shell's `-c` script body: after any word naming a shell (SHELL_COMMANDS), so
 * one behind `env`, `sudo` or `timeout` counts, the first word past that shell's options when they include `c`.
 * The body is shown and redacted as a shell reads it, every other word as one word.
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

/** Where a shell starts a new command: a newline, `;`, `&`, `|`, a parenthesis, a backtick or `$(`. */
const STATEMENT_BREAK = /\n|;|&|\||`|\$\(|\(|\)/
const BREAK_CHARACTERS = new Set(['\n', ';', '&', '|', '`', '(', ')'])
/** Characters before which a `#` starts a word, and so a comment. */
const WORD_BOUNDARY = new Set([' ', '\t', '\r', ...BREAK_CHARACTERS])
/**
 * How many `$(...)` or backtick bodies inside double quotes nest before the rest is called unread. Each level is one
 * more statement holding the levels inside it, so this stays small.
 */
export const MAX_SUBSTITUTIONS = 4

/**
 * The statements of shell text, split where a shell would start a new command, so a pattern written for a command
 * line also meets `curl` inside `bash -c "... | curl ..."`: a newline, `;`, `&`, `|`, a parenthesis, a backtick and
 * `$(` start one, outside quotes, so `git clean -e ';' -f` keeps its `-f` (slice 7 review F2). Each `$(...)` or
 * backtick body inside double quotes is read as statements of its own. A `#` that starts a word comments out its
 * line, and a heredoc body is read line by line, its quotes ending with the line (slice 7b review W7B-4). `deep` says
 * substitutions nest past MAX_SUBSTITUTIONS, so some text was read only as part of the statement around it.
 */
export function shellStatementList(text: string): { statements: string[]; deep: boolean } {
  const { statements, deep } = unquotedSplit(text)
  return { statements: [...new Set(statements.map(statement => statement.trim()).filter(Boolean))], deep }
}

/**
 * A statement split at every separator, quoted or not, so a command inside a quoted string another program runs is
 * met too: candidates to judge besides the statement. Empty when it holds no separator.
 */
export function statementPieces(statement: string): string[] {
  if (!STATEMENT_BREAK.test(statement)) return []
  return statement.split(STATEMENT_BREAK).map(piece => piece.trim()).filter(piece => piece !== '' && piece !== statement)
}

type Quote = null | "'" | "$'" | '"'

/** One level of unquoted shell text: the text itself, or a `$(...)` or backtick body inside double quotes. */
interface SplitLevel {
  start: number
  closer: ')' | '`' | null
  parens: number
  quote: Quote
}

/**
 * Text split at each separator outside quotes. A backslash outside single quotes escapes the next character, and
 * in `$'...'` too (slice 7b review W7B-5). Inside double quotes a `$(...)` or backtick body is split as text of its
 * own, its statements added to the rest.
 */
function unquotedSplit(text: string): { statements: string[]; deep: boolean } {
  const statements: string[] = []
  const levels: SplitLevel[] = [{ start: 0, closer: null, parens: 0, quote: null }]
  const heredocs: Heredoc[] = []
  let deep = false
  const end = (level: SplitLevel, at: number, next: number) => {
    statements.push(text.slice(level.start, at))
    level.start = next
  }
  for (let index = 0; index < text.length; index++) {
    const level = levels.at(-1)!
    const character = text[index]!
    if (level.quote === "'") {
      if (character === "'") level.quote = null
      continue
    }
    if (level.quote === "$'") {
      if (character === '\\') index++
      else if (character === "'") level.quote = null
      continue
    }
    if (level.quote === '"') {
      if (character === '\\') index++
      else if (character === '"') level.quote = null
      else if (character === '`' || (character === '$' && text[index + 1] === '(')) {
        if (levels.length > MAX_SUBSTITUTIONS) deep = true
        else {
          if (character === '$') index++
          levels.push({ start: index + 1, closer: character === '`' ? '`' : ')', parens: 0, quote: null })
        }
      }
      continue
    }
    if (character === '\\') index++
    else if (character === level.closer && (character === '`' || level.parens === 0)) {
      end(level, index, index + 1)
      levels.pop()
    } else if (character === "'") level.quote = text[index - 1] === '$' ? "$'" : "'"
    else if (character === '"') level.quote = '"'
    else if (character === '#' && (index === 0 || WORD_BOUNDARY.has(text[index - 1]!))) {
      const line = text.indexOf('\n', index)
      const stop = line < 0 ? text.length : line
      end(level, index, stop)
      index = stop - 1
    } else if (character === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      const heredoc = heredocAt(text, index + 2)
      if (heredoc) heredocs.push(heredoc.heredoc)
      index = (heredoc?.next ?? index + 2) - 1
    } else if (BREAK_CHARACTERS.has(character)) {
      if (level.closer === ')' && character === '(') level.parens++
      if (level.closer === ')' && character === ')') level.parens--
      end(level, index, index + 1)
      if (character === '\n' && heredocs.length > 0) {
        index = heredocBodies({ text, from: index + 1, heredocs: heredocs.splice(0), statements }) - 1
        level.start = index + 1
      }
    }
  }
  while (levels.length > 0) end(levels.pop()!, text.length, text.length)
  return { statements, deep }
}

interface Heredoc { delimiter: string; tabs: boolean }

/** The heredoc whose `<<` ends just before `at`: its delimiter word with quotes removed, and where the word ends. */
function heredocAt(text: string, at: number): { heredoc: Heredoc; next: number } | null {
  const tabs = text[at] === '-'
  let index = tabs ? at + 1 : at
  while (text[index] === ' ' || text[index] === '\t') index++
  const start = index
  let quote: string | null = null
  while (index < text.length) {
    const character = text[index]!
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") quote = character
    else if (character === '\\') index++
    else if (/[\s;&|()<>]/.test(character)) break
    index++
  }
  const delimiter = unquote(text.slice(start, index))
  return delimiter === '' ? null : { heredoc: { delimiter, tabs }, next: index }
}

/**
 * Each heredoc body after a line, up to each delimiter line, every line split on its own, so a quote in a body ends
 * with its line; where the text goes on. A `<<` that was no heredoc (`$((1<<2))`) only reads the lines after it
 * one at a time.
 */
function heredocBodies(input: { text: string; from: number; heredocs: Heredoc[]; statements: string[] }): number {
  let index = input.from
  for (const heredoc of input.heredocs) {
    while (index < input.text.length) {
      const newline = input.text.indexOf('\n', index)
      const lineEnd = newline < 0 ? input.text.length : newline
      const line = input.text.slice(index, lineEnd)
      index = lineEnd + 1
      if ((heredoc.tabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break
      for (const statement of unquotedSplit(line).statements) input.statements.push(statement)
    }
  }
  return Math.min(index, input.text.length)
}

/** A word of shell text as written (`raw`, quotes kept) and as the command receives it (`word`, quotes removed). */
export interface ShellToken {
  raw: string
  word: string
}

/**
 * Splits on whitespace outside quotes. A quoted run joins the word it touches (`--force'>'` is one word), and an
 * unclosed quote runs to the end; in `$'...'` a backslash escapes the quote (slice 7b review W7B-5). Only `$'` and a
 * plain `$` share a first character, and `$'` is tried first; each run inside an alternative stops at a character
 * that starts another, so the scan stays linear.
 */
const STATEMENT_TOKEN = /(?:"(?:[^"\\]+|\\.)*"?|\$'(?:[^'\\]+|\\.)*'?|'[^']*'?|\\.?|[^\s"'\\$]+|\$)+/g

/** One scanner for shellTokensUpTo, which never calls itself, rewound before each use. */
const TOKEN_SCAN = new RegExp(STATEMENT_TOKEN.source, STATEMENT_TOKEN.flags)

/** Text as a shell would split it into words, roughly, each as written and as the command receives it. */
export function shellTokens(text: string): ShellToken[] {
  return (text.match(STATEMENT_TOKEN) ?? []).map(raw => ({ raw, word: unquote(raw) }))
}

/**
 * The first words of text as a shell would split it, at most `limit` of them; `more` says whether a word was left
 * unread. Reads only as far as it returns.
 */
export function shellTokensUpTo(text: string, limit: number): { tokens: ShellToken[]; more: boolean } {
  const tokens: ShellToken[] = []
  const pattern = TOKEN_SCAN
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (tokens.length >= limit) return { tokens, more: true }
    tokens.push({ raw: match[0], word: unquote(match[0]) })
  }
  return { tokens, more: false }
}

/** Text as a shell would split it into words, roughly: whitespace separates, quotes and backslashes are removed. */
export function shellWords(text: string): string[] {
  return shellTokens(text).map(token => token.word)
}

/**
 * Quote removal as a shell does it: single quotes keep everything; in double quotes a backslash escapes `"`, `\\`,
 * `$` and a backtick; in `$'...'` a backslash escape is decoded (`\'`, `\n`, `\x2d`); outside, a backslash escapes
 * any character.
 */
function unquote(raw: string): string {
  let word = ''
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!
    if (character === '$' && raw[index + 1] === "'") {
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
      word += raw[index] ?? ''
    } else word += character
  }
  return word
}

const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`'])

/** The text of a double-quoted run whose body starts at `from`, escapes removed, copied a run at a time, and the index of its closing quote. */
function doubleQuoted(raw: string, from: number): { text: string; end: number } {
  let text = ''
  let run = from
  let index = from
  for (; index < raw.length && raw[index] !== '"'; index++) {
    if (raw[index] !== '\\') continue
    const escaped = raw[index + 1] ?? ''
    // A backslash before any other character stays, with that character, in the run.
    if (DOUBLE_QUOTE_ESCAPES.has(escaped)) {
      text += raw.slice(run, index) + escaped
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
