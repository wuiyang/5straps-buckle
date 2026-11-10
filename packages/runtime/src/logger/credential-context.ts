import { isCredentialQueryName, isNamedCredentialKey } from './credential-names.js'

export const REDACTED = '[redacted]'

/**
 * What an approval display hides (owner ruling B, 2026-10-03: "hide whole-URL and named-key values only"). The
 * approver sees the full raw action (owner decisions D9 and D17); hiding is display only, and what a decision binds
 * is the raw call.
 *
 * - `value`: one value read whole, such as an argv word, a URL field, an `env` value or a description fact. A whole
 *   URL keeps all but its password and its credential query values (redactUrl). A named argument or assignment
 *   (`--password=x`, `DB_PASSWORD=x`) whose name holds password, secret or token (isNamedCredentialKey) has its value
 *   replaced whole; any other one's value is read as a URL.
 * - `json`: a JSON object or array. A named key's value is replaced whole when it is a number or another scalar, or a
 *   string that is one plain shell word; a longer string (a package.json script body under a token-named key) is read
 *   as a `value`, and an object or array is read key by key. Every other string is read as a `value`. Text that is not
 *   one is read as `text`.
 * - `text`: free text, such as a file's content or a reason. Only an env-style line (`DB_PASSWORD=x`,
 *   `export API_TOKEN='x' # comment`) is read, as a `value` is; every other line shows as written.
 *
 * Nothing else is hidden: a URL inside a longer word, a shell script, a script body, a heredoc and free text show raw
 * (slice 7b review R7B-CR-1 to R7B-CR-4, slice 7d review R7D-WV-1 and R7D-WV-2). A named argument's or line's value
 * is hidden only when it is one plain shell word with nothing after it, and a URL's password or query value only when
 * it holds no whitespace or shell character, so what they hide never holds a statement a shell would run.
 */
export type CredentialContext = 'value' | 'json' | 'text'

/** `text` in its context with what owner ruling B hides replaced by `[redacted]`, the rest as written. Uncapped. */
export function redactCredentials(text: string, context: CredentialContext): string {
  if (context === 'value') return redactValue(text)
  if (context === 'json') return redactJson(text) ?? redactLines(text)
  return redactLines(text)
}

/**
 * A value that is one whole URL, after trimming and inside one pair of matching quotes when it has them, rebuilt from
 * its own text with its password and each credential query value (isCredentialQueryName) replaced by `[redacted]`;
 * any other value as written. A URL is what `new URL()` parses. A password or value that holds whitespace, a quote, a
 * backslash or a shell character (`$`, backtick, `;`, `&`, `|`, `<`, `>`, a parenthesis or a brace) shows, so what is
 * hidden is plain text inside one word wherever a shell reads it, never a statement, a substitution or a redirection.
 */
export function redactUrl(value: string): string {
  let from = value.length - value.trimStart().length
  let url = value.trim()
  const quote = url[0]
  if (url.length > 2 && (quote === '"' || quote === "'") && url.at(-1) === quote) {
    url = url.slice(1, -1)
    from += 1
  }
  const ranges = urlCredentialRanges(url)
  return ranges.length === 0 ? value : redactRanges(value, ranges.map(range => ({ start: range.start + from, end: range.end + from })))
}

interface Range { start: number; end: number }

/** What a hidden password or query value may not hold: whitespace, a quote, a backslash or a shell character. */
const SHELL_TEXT = /[\s'"\\`$;&|<>(){}]/
/** Schemes whose authority a backslash also ends, as `new URL()` reads them. */
const SPECIAL_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:'])

/** Where in a URL its password and its credential query values sit, each plain text; none when it is not a URL. */
function urlCredentialRanges(url: string): Range[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  const ranges: Range[] = []
  const password = passwordRange(url, parsed)
  if (password) ranges.push(password)
  const query = url.search(/[?#]/)
  if (url[query] === '?') {
    const fragment = url.indexOf('#', query)
    queryRanges(url, query + 1, fragment < 0 ? url.length : fragment, ranges)
  }
  return ranges.filter(range => !SHELL_TEXT.test(url.slice(range.start, range.end)))
}

/** The password between the first `:` and the last `@` of the authority, as `new URL()` reads it. */
function passwordRange(url: string, parsed: URL): Range | null {
  if (parsed.password === '') return null
  const scheme = url.indexOf(':')
  if (!url.startsWith('//', scheme + 1)) return null
  const start = scheme + 3
  const length = url.slice(start).search(SPECIAL_SCHEMES.has(parsed.protocol) ? /[/?#\\]/ : /[/?#]/)
  const end = length < 0 ? url.length : start + length
  const at = url.lastIndexOf('@', end - 1)
  const split = url.indexOf(':', start)
  return at >= start && split >= 0 && split < at - 1 ? { start: split + 1, end: at } : null
}

function queryRanges(url: string, start: number, end: number, ranges: Range[]): void {
  for (let from = start; from < end;) {
    const next = url.indexOf('&', from)
    const to = next < 0 || next > end ? end : next
    const pair = url.slice(from, to)
    const equals = pair.indexOf('=')
    if (equals > 0 && equals < pair.length - 1 && isCredentialQueryName(decoded(pair.slice(0, equals)), decoded(pair.slice(equals + 1)))) ranges.push({ start: from + equals + 1, end: to })
    from = to + 1
  }
}

/** A query name or value as a form decodes it; as written when it does not decode. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '))
  } catch {
    return text
  }
}

const ASSIGNMENT = /^\s*(?:export\s+|--?)?([A-Za-z_][\w.-]*)=/
const VALUE_WORD = /^(?:'[^'\n\r]*'|"[^"\n\r]*"|[^\s'"]+)/
/** One plain shell word, which a named key's value must be: a single-quoted run, a double-quoted run with no `\`, `$` or backtick, or an unquoted run with no shell character. */
const PLAIN_WORD = /^(?:'[^'\n\r]+'|"[^"\\$`\n\r]+"|[^\s'"\\`$;&|<>(){}]+)$/
/** What may follow an env-style line's value: whitespace, and a `#` comment after whitespace. */
const LINE_TRAILER = /^(?:\s+#.*)?\s*$/
const LINES = /^.*$/gm

function redactValue(value: string): string {
  return redactAssignment(value, false) ?? redactUrl(value)
}

function redactLines(text: string): string {
  return text.replace(LINES, line => redactAssignment(line, true) ?? line)
}

/**
 * A `NAME=VALUE` text whose value is one word with nothing after it (a line may end in a `#` comment): the value
 * hidden whole when the name holds password, secret or token and the value is one plain shell word, else read as a
 * URL; null when the text is no such assignment, or a named key's value is more than one plain shell word.
 */
function redactAssignment(text: string, line: boolean): string | null {
  const assignment = ASSIGNMENT.exec(text)
  if (!assignment) return null
  const start = assignment[0].length
  const word = VALUE_WORD.exec(text.slice(start))?.[0]
  if (word === undefined) return null
  const rest = text.slice(start + word.length)
  if (line ? !LINE_TRAILER.test(rest) : rest.trim() !== '') return null
  if (!isNamedCredentialKey(assignment[1]!, word)) return `${text.slice(0, start)}${redactUrl(word)}${rest}`
  return PLAIN_WORD.test(word) ? `${text.slice(0, start)}${REDACTED}${rest}` : null
}

const JSON_DOCUMENT = /^\s*[[{]/
const JSON_SPACE = new Set([' ', '\t', '\n', '\r'])

/** A JSON object or array with each named key's plain value replaced whole (namedValueEnd) and every other string read as a value; null when the text is not one. */
function redactJson(text: string): string | null {
  if (!JSON_DOCUMENT.test(text)) return null
  try {
    JSON.parse(text)
  } catch {
    return null
  }
  return redactJsonDocument(text)
}

function redactJsonDocument(text: string): string {
  let shown = ''
  let cursor = 0
  const containers: boolean[] = []
  let keyNext = false
  let key: string | null = null
  for (let index = 0; index < text.length;) {
    const character = text[index]!
    if (JSON_SPACE.has(character) || character === ':') index++
    else if (character === ',') {
      keyNext = containers.at(-1) === true
      index++
    } else if (character === '}' || character === ']') {
      containers.pop()
      key = null
      index++
    } else if (keyNext) {
      const end = closingQuote(text, index)
      key = JSON.parse(text.slice(index, end + 1)) as string
      keyNext = false
      index = end + 1
    } else {
      const under = key
      key = null
      const end = under !== null && isNamedCredentialKey(under) ? namedValueEnd(text, index, under) : -1
      if (end >= 0) {
        shown += `${text.slice(cursor, index)}${JSON.stringify(REDACTED)}`
        cursor = end
        index = end
      } else if (character === '{' || character === '[') {
        containers.push(character === '{')
        keyNext = character === '{'
        index++
      } else if (character === '"') {
        const close = closingQuote(text, index)
        const value = JSON.parse(text.slice(index, close + 1)) as string
        const redacted = redactValue(value)
        if (redacted !== value) {
          shown += `${text.slice(cursor, index)}${JSON.stringify(redacted)}`
          cursor = close + 1
        }
        index = close + 1
      } else index = scalarEnd(text, index)
    }
  }
  return shown + text.slice(cursor)
}

/**
 * The index after the value at `start` under a named key when it is hidden whole: a scalar that is no count the key names
 * (max_tokens), and when a string, one plain shell word (PLAIN_WORD), the test a named argument's value meets; -1 for a
 * longer string, such as a script body npm runs, and for an object or array, whose own keys are read instead.
 */
function namedValueEnd(text: string, start: number, key: string): number {
  const opening = text[start]
  if (opening === '{' || opening === '[') return -1
  const end = opening === '"' ? closingQuote(text, start) + 1 : scalarEnd(text, start)
  const value: unknown = JSON.parse(text.slice(start, end))
  if (!isNamedCredentialKey(key, value)) return -1
  return typeof value !== 'string' || PLAIN_WORD.test(value) ? end : -1
}

function scalarEnd(text: string, start: number): number {
  let index = start
  while (index < text.length && !JSON_SPACE.has(text[index]!) && text[index] !== ',' && text[index] !== '}' && text[index] !== ']') index++
  return index
}

function closingQuote(text: string, open: number): number {
  let index = open + 1
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1
  return index
}

function redactRanges(text: string, ranges: Range[]): string {
  let shown = ''
  let cursor = 0
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    shown += `${text.slice(cursor, range.start)}${REDACTED}`
    cursor = range.end
  }
  return shown + text.slice(cursor)
}
