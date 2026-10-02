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

/** Where a shell takes its script from: a `-c` string, a file, its own input, or nowhere (`bash -c` with no string, `bash --version`). */
export type ShellScriptSource = 'command' | 'missingCommand' | 'file' | 'input' | 'none'

/** Script operands through which a shell reads its own input. */
export const INPUT_PATHS: ReadonlySet<string> = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
/** Long options after which a shell prints and runs nothing. */
const SHELL_INFO_OPTIONS = new Set(['--version', '--help'])

/**
 * Where a shell call takes its script from, its options read as shellBodyIndexes reads them: with `c` among its
 * options the first operand is the script, and with none the call has no script (`missingCommand`); with `s`, with no
 * operand, or with an operand naming its own input, the script is that input; any other operand is a script file.
 */
export function shellScriptSource(args: readonly string[]): ShellScriptSource {
  let command = false
  let input = false
  let index = 0
  for (; index < args.length; index++) {
    const word = args[index]!
    if (word === '--' || word === '-') {
      index++
      break
    }
    if (word.length < 2 || (word[0] !== '-' && word[0] !== '+')) break
    if (word.startsWith('--')) {
      if (SHELL_INFO_OPTIONS.has(word)) return 'none'
      if (SHELL_LONG_VALUE_OPTIONS.has(word)) index++
      continue
    }
    if (word[0] === '-' && word.includes('c')) command = true
    if (word[0] === '-' && word.includes('s')) input = true
    if ([...word.slice(1)].some(flag => SHELL_VALUE_OPTIONS.has(flag))) index++
  }
  const operand = args[index]
  if (command) return operand === undefined ? 'missingCommand' : 'command'
  return input || operand === undefined || INPUT_PATHS.has(operand) ? 'input' : 'file'
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
 */
export function shellStatementList(text: string): { statements: string[]; deep: boolean; overDepth: boolean } {
  const { statements, deep, overDepth } = unquotedSplit(text, SHELL_TEXT, 0)
  return { statements: [...new Set(statements.map(trimmed).filter(Boolean))], deep, overDepth }
}

/**
 * A statement without the whitespace around it. A space, tab or carriage return a backslash escapes is part of a word
 * (`\ `), so it stays; a backslash before a newline that ends the statement continues the line into nothing, so both go.
 */
function trimmed(statement: string): string {
  const text = statement.trimStart()
  let end = text.length
  while (end > 0 && /\s/.test(text[end - 1]!)) end--
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

/** `heredoc` is the text of a heredoc body under an unquoted delimiter: like `"`, but no quote ends it. */
type Quote = null | "'" | "$'" | '"' | 'heredoc'

/** One level of unquoted shell text: the text itself, or a `$(...)` or backtick body inside double quotes or heredoc text. */
interface SplitLevel {
  start: number
  closer: ')' | '`' | null
  parens: number
  quote: Quote
  /** Where a backtick level's body starts, and whether double quotes hold it, so `\"` in it is an escape too. */
  body: number
  doubleQuoted: boolean
  /** Where the body of a backtick met at this level outside quotes starts, until its closing backtick; null when none is open. */
  backtick: number | null
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
 */
function unquotedSplit(text: string, mode: SplitMode, depth: number): { statements: string[]; deep: boolean; overDepth: boolean } {
  const statements: string[] = []
  const levels: SplitLevel[] = [{ start: 0, closer: null, parens: 0, quote: mode.heredocText ? 'heredoc' : null, body: 0, doubleQuoted: false, backtick: null }]
  const heredocs: Heredoc[] = []
  let deep = false
  let overDepth = false
  const end = (level: SplitLevel, at: number, next: number) => {
    statements.push(text.slice(level.start, at))
    level.start = next
  }
  // A backtick body is also read as bash runs it, its escapes removed first (backtickView), and each body that removal
  // reveals is read the same way in turn, each level counting against MAX_DEPTH (slice 7h probes).
  const readBacktick = (body: string, doubleQuoted: boolean) => {
    if (!body.includes('\\')) return
    if (depth >= MAX_DEPTH) {
      overDepth = true
      return
    }
    const split = unquotedSplit(backtickView(body, doubleQuoted), mode.wholeBodies ? SHELL_TEXT : SHELL_LINE, depth + 1)
    for (const statement of split.statements) statements.push(statement)
    deep ||= split.deep
    overDepth ||= split.overDepth
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
    if (level.quote === '"' || level.quote === 'heredoc') {
      if (character === '\\') index++
      else if (character === '"' && level.quote === '"') level.quote = null
      else if (character === '`' || (character === '$' && text[index + 1] === '(')) {
        if (levels.length > MAX_SUBSTITUTIONS) deep = true
        else {
          if (character === '$') index++
          levels.push({ start: index + 1, closer: character === '`' ? '`' : ')', parens: 0, quote: null, body: index + 1, doubleQuoted: level.quote === '"', backtick: null })
        }
      }
      continue
    }
    if (character === '\\') index++
    else if (character === level.closer && (character === '`' || level.parens === 0)) {
      end(level, index, index + 1)
      levels.pop()
      if (character === '`') readBacktick(text.slice(level.body, index), level.doubleQuoted)
    } else if (character === '`') {
      // A backtick outside quotes opens a body or closes the one open at this level; either way it splits a statement.
      end(level, index, index + 1)
      if (level.backtick === null) level.backtick = index + 1
      else {
        readBacktick(text.slice(level.backtick, index), false)
        level.backtick = null
      }
    } else if (character === "'") level.quote = text[index - 1] === '$' ? "$'" : "'"
    else if (character === '"') level.quote = '"'
    else if (character === '#' && (index === 0 || WORD_BOUNDARY.has(text[index - 1]!))) {
      const stop = commentEnd(text, index, level.closer === '`' || level.backtick !== null)
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
        const bodies = heredocBodies({ text, from: index + 1, heredocs: heredocs.splice(0), statements, whole: mode.wholeBodies, depth })
        deep ||= bodies.deep
        overDepth ||= bodies.overDepth
        index = bodies.next - 1
        level.start = index + 1
      }
    }
  }
  while (levels.length > (mode.heredocText ? 1 : 0)) end(levels.pop()!, text.length, text.length)
  return { statements, deep, overDepth }
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

/** `quoted` when any part of the delimiter word is quoted, so bash expands nothing in the body. */
interface Heredoc { delimiter: string; tabs: boolean; quoted: boolean }

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
  const word = text.slice(start, index)
  const delimiter = unquote(word)
  return delimiter === '' ? null : { heredoc: { delimiter, tabs, quoted: /['"\\]/.test(word) }, next: index }
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
function heredocBodies(input: { text: string; from: number; heredocs: Heredoc[]; statements: string[]; whole: boolean; depth: number }): { next: number; deep: boolean; overDepth: boolean } {
  let index = input.from
  let deep = false
  let overDepth = false
  const read = (text: string, mode: SplitMode, depth: number) => {
    const split = unquotedSplit(text, mode, depth)
    for (const statement of split.statements) input.statements.push(statement)
    deep ||= split.deep
    overDepth ||= split.overDepth
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
      read(line, SHELL_LINE, input.depth)
      if (!heredoc.quoted) read(line, HEREDOC_TEXT, input.depth)
      const joining = joiningBackslashes(bodyLine, heredoc.quoted)
      if (joined !== null || joining !== 0) {
        joined = (joined ?? '') + bodyLine.slice(0, bodyLine.length - joining)
        if (joining === 0) {
          read(joined, SHELL_LINE, input.depth)
          joined = null
        }
      }
      // Only an odd run of backslashes joins a line to the next for the heredoc reader (bash does not halve `\\`
      // before it recognises the delimiter), and a quoted delimiter joins nothing.
      continues = !heredoc.quoted && trailingBackslashRun(bodyLine) % 2 === 1
    }
    // A run still open at the delimiter line, or at the end of the text, is read as it stands.
    if (joined !== null) read(joined, SHELL_LINE, input.depth)
    if (bodyEnd > bodyStart && input.whole) {
      const body = input.text.slice(bodyStart, bodyEnd)
      if (!heredoc.quoted) read(body.replace(CONTINUED_LINE, joinLine), HEREDOC_TEXT, input.depth)
      // The fed shell may run the whole body (`bash <<EOF`, `bash <<'EOF'`), its quotes spanning lines; an unquoted
      // body is read as the shell receives it, a quoted one as the raw body, and each nested heredoc read whole in
      // turn counts one level against MAX_DEPTH, past which the call is left unread (slice 7f review R7F-HR-3, R7F-HR-4).
      if (input.depth >= MAX_DEPTH) overDepth = true
      else {
        // A `<<-` delimiter strips the leading tabs of each line before the shell receives the body.
        const stripped = heredoc.tabs ? body.replace(/^\t+/gm, '') : body
        read(heredoc.quoted || !stripped.includes('\\') ? stripped : fedShellView(stripped), SHELL_TEXT, input.depth + 1)
      }
    }
  }
  return { next: Math.min(index, input.text.length), deep, overDepth }
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
 * continuation, and four are two literal backslashes.
 */
function fedShellView(body: string): string {
  let view = ''
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!
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

/**
 * Splits on whitespace outside quotes. A quoted run joins the word it touches (`--force'>'` is one word), and an
 * unclosed quote runs to the end; in `$'...'` a backslash escapes the quote (slice 7b review W7B-5). Only `$'` and a
 * plain `$` share a first character, and `$'` is tried first; each run inside an alternative stops at a character
 * that starts another, so the scan stays linear. A backslash-newline outside single quotes is a line continuation,
 * which bash removes before it splits words, so it joins the word it sits in (`--for\` then `ce` is `--force`) and
 * separates nothing (slice 7h probe: a continuation inside a word or a command name hid it from every rule).
 */
const STATEMENT_TOKEN = /(?:"(?:[^"\\]+|\\[\s\S])*"?|\$'(?:[^'\\]+|\\[\s\S])*'?|'[^']*'?|\\[\s\S]?|[^\s"'\\$]+|\$)+/g

/** One scanner for shellTokensUpTo, which never calls itself, rewound before each use. */
const TOKEN_SCAN = new RegExp(STATEMENT_TOKEN.source, STATEMENT_TOKEN.flags)

/** A run of line continuations between words, which bash removes and which is no word. */
const CONTINUATIONS_ONLY = /^(?:\\\n)+$/

/** Text as a shell would split it into words, roughly, each as written and as the command receives it. */
export function shellTokens(text: string): ShellToken[] {
  return (text.match(STATEMENT_TOKEN) ?? []).filter(raw => !CONTINUATIONS_ONLY.test(raw)).map(raw => ({ raw, word: unquote(raw) }))
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
    if (CONTINUATIONS_ONLY.test(match[0])) continue
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
 * any character, and one with nothing after it stays. Outside single quotes a backslash-newline is a line
 * continuation and leaves nothing.
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
      // A backslash that ends the text escapes nothing, and bash keeps it (`bash -c 'echo a\'` prints `a\`).
      if (index >= raw.length) word += '\\'
      else if (raw[index] !== '\n') word += raw[index]
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
