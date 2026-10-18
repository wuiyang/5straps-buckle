// The single-statement grammar (fix brief 4, P). Shell text is rated only when it is one simple command the reader
// parses whole; anything else is refused, so a person decides. This is deliberately a small grammar, not a shell parser:
// a character it does not model in the place it meets it refuses the whole text.
import { baseCommand, shellLeadingWords } from '../../domain/argv.js'
import { commandForms, isInterpreter } from '../../domain/command-forms.js'

/** Why the reader rates no code of shell text it does not parse whole (fix brief 4, P). */
export const SHELL_TEXT_REFUSAL = 'shell text the reader does not rate whole'

/** What feeds the one statement's standard input: a file, a heredoc's body, or a here-string's word. */
export type StatementFeed = { kind: 'file'; name: string } | { kind: 'heredoc'; body: string } | { kind: 'hereString'; code: string }

/** One simple command: its words after its leading assignments, quotes removed, and the one feed on its input, if any. */
export interface SimpleStatement { words: string[]; feed: StatementFeed | null }

/**
 * The POSIX-family shells whose text the grammar reads. fish quotes differently and the C shells parse differently, so
 * their text is never rated; nor is any shell this list leaves out.
 */
const RATED_SHELLS = new Set(['bash', 'rbash', 'sh', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'yash', 'posh'])
/** The shells that have here-strings (`<<<`); in another, `<<<` is not a feed the grammar reads. */
const HERE_STRING_SHELLS = new Set(['bash', 'rbash', 'zsh', 'ksh', 'mksh', 'yash'])
/** The shells that read `&>` as one redirection of both outputs; dash reads it as `&` (a background job) then `>`. */
const BOTH_OUTPUTS_SHELLS = new Set(['bash', 'rbash', 'zsh'])
/** The wrappers a statement's command may stand behind (fix brief 1, item 9); behind any other, the statement is not rated. */
const STATEMENT_WRAPPERS = new Set(['env', 'timeout', 'nice', 'nohup', 'stdbuf', 'exec', 'command'])

/**
 * The shell options before a `-c` text that change nothing the grammar reads: clusters of c, e, u, v, f, and n (the
 * `-c` among them), `+` clusters of the same letters but c, and `-o`/`+o` with one of a few settings. `-i` and `-l`
 * (startup files), `-k` (assignments anywhere), `-x` (bash expands a trace prompt the environment may set, running
 * what it substitutes), `-s`, `-O`, and every long option are left out, so they refuse.
 */
const SHELL_OPTION = /^(?:-[ceuvfn]+|\+[euvfn]+)$/
const SHELL_SETTING_OPTIONS = new Set(['-o', '+o'])
const SHELL_SETTINGS = new Set(['errexit', 'nounset', 'pipefail', 'verbose', 'noglob'])

/** The shell and its `-c` text, where a form is a rated shell whose options are all ones the grammar models; else null. */
export function ratedShellText(form: readonly string[]): { shell: string; text: string } | null {
  const shell = baseCommand(form[0] ?? '')
  if (!RATED_SHELLS.has(shell)) return null
  const args = form.slice(1)
  const { leading, operand, command } = shellLeadingWords(args)
  const text = args[operand]
  if (!command || text === undefined) return null
  for (let index = 0; index < leading.length; index++) {
    const { word, role } = leading[index]!
    if (role === 'value') {
      if (!SHELL_SETTINGS.has(word) || !SHELL_SETTING_OPTIONS.has(leading[index - 1]?.word ?? '')) return null
    } else if (!SHELL_OPTION.test(word) && !(SHELL_SETTING_OPTIONS.has(word) && leading[index + 1]?.role === 'value')) {
      return null
    }
  }
  return { shell, text }
}

/**
 * The interpreter form one statement runs: its command through the known wrappers (STATEMENT_WRAPPERS), as the rules
 * read it, which must end in an interpreter and read nothing nested; null otherwise.
 */
export function statementInterpreter(statement: SimpleStatement): string[] | null {
  const [command, ...args] = statement.words
  if (command === undefined) return null
  const forms = commandForms(command, args)
  if (forms.unread !== null || forms.overBudget || forms.scriptData || forms.nested.length > 0) return null
  const final = forms.chain.at(-1)!
  if (forms.chain.slice(0, -1).some(([word = '']) => !STATEMENT_WRAPPERS.has(baseCommand(word)))) return null
  return isInterpreter(baseCommand(final[0] ?? '')) ? final : null
}

/** A character a word may hold unquoted: none a shell expands, globs, splits on, or reads as an operator. */
const PLAIN = /^[A-Za-z0-9_\-./,:+@%=]$/
/** A redirection operator at a word's start, with the descriptor digits before it. */
const REDIRECTION = /(\d*)(<<<|<<-|<<|<>|<&|<|>>|>\||>&|>|&>>|&>)/y
/** A leading assignment: an unquoted name, then `=`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

interface Word { raw: string; value: string; quoted: boolean; end: number }

/**
 * One shell text as a single simple command (fix brief 4, P), or null where it is anything else: a list or pipe operator
 * (`;`, `&&`, `||`, `|`, `&`, or a newline between statements), a subshell, group, function, or compound command, a
 * command, process, or arithmetic substitution, a parameter, tilde, glob, or brace expansion, a comment, a second feed on
 * the input, an input on another descriptor, a duplicated input, a heredoc left open or one whose body a shell would
 * expand, or a quote left open. Leading assignments are kept apart from the words; output redirections are allowed and
 * dropped. Blank lines may stand before and after the statement.
 */
export function simpleStatement(text: string, shell: string): SimpleStatement | null {
  const words: Word[] = []
  let feed: StatementFeed | null = null
  let heredoc: { delimiter: string; quoted: boolean; tabs: boolean } | null = null
  let at = /^[ \t\n]*/.exec(text)![0].length
  for (;;) {
    at = skipBlanks(text, at)
    if (at >= text.length || text[at] === '\n') break
    REDIRECTION.lastIndex = at
    const redirection = REDIRECTION.exec(text)
    if (redirection) {
      const [whole, digits = '', operator = ''] = redirection
      if (operator.startsWith('&') && (digits !== '' || !BOTH_OUTPUTS_SHELLS.has(shell))) return null
      const target = readWord(text, skipBlanks(text, at + whole.length))
      if (target === null || target.raw === '') return null
      at = target.end
      const input = operator.startsWith('<')
      const descriptor = digits === '' ? (input ? 0 : 1) : Number(digits)
      if (!input) {
        // An output redirection writes its target; nothing reads it as code. One onto the input is no output.
        if (descriptor === 0) return null
        continue
      }
      if (descriptor !== 0 || operator === '<&' || feed !== null) return null
      if (operator === '<<<') {
        if (!HERE_STRING_SHELLS.has(shell)) return null
        feed = { kind: 'hereString', code: target.value }
      } else if (operator === '<<' || operator === '<<-') {
        heredoc = { delimiter: target.value, quoted: target.quoted, tabs: operator === '<<-' }
        feed = { kind: 'heredoc', body: '' }
      } else {
        feed = { kind: 'file', name: target.value }
      }
      continue
    }
    const word = readWord(text, at)
    if (word === null || word.end === at) return null
    words.push(word)
    at = word.end
  }
  // The statement ends at the text's end or its first unquoted newline; a heredoc's body follows that newline.
  let rest = text.slice(at)
  if (heredoc !== null) {
    const body = heredocBody(text, at + 1, heredoc)
    if (body === null) return null
    feed = { kind: 'heredoc', body: body.body }
    rest = body.rest
  }
  if (!/^[ \t\n]*$/.test(rest)) return null
  const first = words.findIndex(word => !ASSIGNMENT.test(word.raw))
  if (first < 0) return null
  return { words: words.slice(first).map(word => word.value), feed }
}

/** The index past blanks and line continuations (a backslash before a newline), never past a newline itself. */
function skipBlanks(text: string, from: number): number {
  let at = from
  for (;;) {
    if (text[at] === ' ' || text[at] === '\t') at++
    else if (text[at] === '\\' && text[at + 1] === '\n') at += 2
    else return at
  }
}

/**
 * One word from `from`, with quotes removed: single quotes literal, double quotes with `\` escaping `$`, `` ` ``, `"`, `\`,
 * and a newline, and a backslash outside quotes escaping the next character. It ends at a blank, a newline, or an
 * operator character, and is null where it holds an expansion or a substitution (`$`, a backtick), a character outside
 * PLAIN unquoted, a `=` that starts it (zsh's command-path expansion), or a quote left open.
 */
function readWord(text: string, from: number): Word | null {
  let value = ''
  let quoted = false
  let at = from
  while (at < text.length) {
    const character = text[at]!
    if (' \t\n;&|()<>'.includes(character)) break
    if (character === "'") {
      const close = text.indexOf("'", at + 1)
      if (close < 0) return null
      value += text.slice(at + 1, close)
      quoted = true
      at = close + 1
    } else if (character === '"') {
      const inside = doubleQuoted(text, at + 1)
      if (inside === null) return null
      value += inside.value
      quoted = true
      at = inside.end
    } else if (character === '\\') {
      const next = text[at + 1]
      if (next === undefined) return null
      if (next !== '\n') {
        value += next
        quoted = true
      }
      at += 2
    } else if ((PLAIN.test(character) || character.charCodeAt(0) >= 0x80) && !(character === '=' && at === from)) {
      value += character
      at++
    } else {
      return null
    }
  }
  return { raw: text.slice(from, at), value, quoted, end: at }
}

/** A double-quoted string's text from just after its `"` to its closing one; null at an expansion or an open quote. */
function doubleQuoted(text: string, from: number): { value: string; end: number } | null {
  let value = ''
  for (let at = from; at < text.length; at++) {
    const character = text[at]!
    if (character === '"') return { value, end: at + 1 }
    if (character === '$' || character === '`') return null
    if (character === '\\' && at + 1 < text.length && '$`"\\\n'.includes(text[at + 1]!)) {
      if (text[at + 1] !== '\n') value += text[at + 1]
      at++
      continue
    }
    value += character
  }
  return null
}

/**
 * A heredoc's body from `from`, the line after its statement, to its delimiter line (leading tabs dropped for `<<-`),
 * with the text after that line. Null where no line closes it, or where its delimiter is unquoted and the body holds
 * `$`, a backtick, or a backslash, which a shell would expand or join, so the code it hands on is not the text read.
 */
function heredocBody(text: string, from: number, heredoc: { delimiter: string; quoted: boolean; tabs: boolean }): { body: string; rest: string } | null {
  const lines: string[] = []
  for (let start = from; start <= text.length;) {
    const end = text.indexOf('\n', start)
    const raw = text.slice(start, end < 0 ? text.length : end)
    const line = heredoc.tabs ? raw.replace(/^\t+/, '') : raw
    if (line === heredoc.delimiter) {
      const body = lines.join('\n')
      if (!heredoc.quoted && /[$`\\]/.test(body)) return null
      return { body, rest: end < 0 ? '' : text.slice(end + 1) }
    }
    if (end < 0) return null
    lines.push(line)
    start = end + 1
  }
  return null
}
