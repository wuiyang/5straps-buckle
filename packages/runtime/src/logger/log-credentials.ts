import { REDACTED } from './credential-context.js'
import { isCredentialParameter } from './credential-names.js'

/**
 * The process log's credential matcher (owner decision D21, "context"; slice 7 review R7-H1 to R7-H4). A log line is
 * not an action anyone approves, so the log keeps hiding a URL's credentials wherever its text holds one; what an
 * approver sees follows owner ruling B instead (credential-context.ts).
 *
 * - A JSON message: each string read as a `word`, the rest kept as written.
 * - Any other text: free `text`.
 * - `word`: one unit read whole. Quotes and shell characters inside it are content, so `https://u:p$1&x(y)!;z@host`
 *   hides its whole userinfo.
 * - `text`: a URL no quote opened also ends at `<`, `>`, `|`, a backtick, `$(`, a bracket it did not open and a `,`
 *   or `;` before whitespace; one a quote opened ends at its closing quote, and its userinfo may hold a space
 *   (`'https://user:short password@host'`). Its authority also ends at any `,`, so a CSV row's fields after a URL
 *   show; a `;` before other text continues it (owner default N2 (a)).
 *
 * In both a URL's userinfo ends at the last `@` of its authority, which ends at `/`, `?` or `#`, and in `word` at
 * whitespace too. A quote opens a URL only when it sits at the start or after whitespace, `=`, `:`, `(`, `[`, `{` or
 * `,` (`''https://...` and `'abc'https://...` are not opened); the URL then ends at the closing quote on its line. A
 * bracket right before a scheme ends the URL where it closes. A credential parameter's value (isCredentialParameter)
 * ends at `&`, `#` or the end of the URL when the URL is its whole unit (owner decision D24): a word that is the URL,
 * or holds it after a prefix with no whitespace, quote, shell character, `$`, brace or backslash (`--url=`), and runs
 * to the word's end, or a quoted URL; a `$(` or a backtick still ends it in double quotes. Anywhere else it also ends
 * at `;`, `|`, a backtick, `$(`, `<`, `>`, a parenthesis and a line end (default D31), and in `text` at a `,` (owner
 * default N2 (a)). A parameter that names no credential is read through, so a `;` or `?` inside its value still
 * starts one that may. Every scan is linear in the text.
 */
export function redactLogCredentials(text: string): string {
  return redactJson(text) ?? redactRanges(text, urlRanges(text, 'text'))
}

interface Range { start: number; end: number }
type UnitContext = 'word' | 'text'

/** A URL with a scheme, or a request target: a `/` at the start or after whitespace, a bracket, a quote, `=`, `<` or `>`. */
const URL_START = /\b[a-z][a-z0-9+.-]{0,63}:\/\/|(?<=^|[\s("'=<>])\//gi
const OPENS_AFTER = /[\s=:([{,]/
const BRACKET_CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' }
const OPEN_BRACKETS = new Set(['(', '[', '{'])
const CLOSE_BRACKETS = new Set([')', ']', '}'])
const TEXT_ENDS = new Set(['<', '>', '|', '`'])
const QUOTES = new Set(['"', "'"])
const SPACE = /\s/
const PARAMETER_SEPARATORS = new Set(['?', '&', '#', ';'])
const NAME_ENDS = new Set(['=', '?', '&', '#', ';'])

/** Where a credential parameter's value ends: the characters, and whether a `$(` ends it too. */
interface ValueRule { ends: ReadonlySet<string>; substitution: boolean }
const SHELL_VALUE_ENDS = new Set(['&', '#', ';', '|', '`', '<', '>', '(', ')', '\n', '\r'])
const VALUE_RULES = {
  /** A URL that is its whole unit (owner decision D24). */
  url: { ends: new Set(['&', '#']), substitution: false },
  /** A double-quoted URL, where a shell still runs a `$(` or a backtick. */
  doubleQuoted: { ends: new Set(['&', '#', '`']), substitution: true },
  /** A URL in a word that holds more than the URL (default D31). */
  shell: { ends: SHELL_VALUE_ENDS, substitution: true },
  /** Free text, where a `,` ends the value as it ends the authority (owner default N2 (a)). */
  text: { ends: new Set([...SHELL_VALUE_ENDS, ',']), substitution: true },
} as const satisfies Record<string, ValueRule>
/** What before a URL in its word makes the word more than a URL field: whitespace, a quote, a shell character, `$`, a brace or a backslash. */
const BEFORE_URL_FIELD = /[\s'"`;&|()<>${}\\]/
const TRAILING_PUNCTUATION = new Set([')', '.', ',', ';', ':', '!', '?'])
const JSON_DOCUMENT = /^\s*[[{]/

interface Opening {
  limit: number
  quoted: boolean
  closer?: string
}

type NextIndex = (character: string, from: number) => number

function nextIndexIn(text: string): NextIndex {
  const found = new Map<string, { from: number; at: number }>()
  return (character, from) => {
    const known = found.get(character)
    if (known && known.from <= from && (known.at === -1 || known.at >= from)) return known.at
    const at = text.indexOf(character, from)
    found.set(character, { from, at })
    return at
  }
}

function urlRanges(unit: string, context: UnitContext): Range[] {
  const ranges: Range[] = []
  const next = nextIndexIn(unit)
  const pattern = new RegExp(URL_START.source, URL_START.flags)
  const beforeField = context === 'word' ? unit.search(BEFORE_URL_FIELD) : -1
  // A URL inside another's query was scanned with it; its own userinfo is still judged.
  let covered = 0
  for (let match = pattern.exec(unit); match; match = pattern.exec(unit)) {
    const at = match.index
    const opening = openingAt(unit, at, next)
    const ends = endsOf(unit, opening, context)
    let from = at + match[0].length
    if (match[0] !== '/') {
      const authority = scanAuthority({ unit, from, opening, context, ends })
      if (authority.lastAt >= 0) ranges.push({ start: from, end: authority.lastAt })
      from = authority.end
    }
    if (at < covered) continue
    covered = scanRest({ unit, from, opening, context, ends })
    const whole = covered === unit.length && (beforeField < 0 || beforeField >= at)
    parameterRanges({ text: unit, from, end: covered, ranges, rule: valueRule({ unit, at, opening, context, whole }) })
  }
  return ranges
}

/**
 * How a URL's credential values end (owner decision D24, default D31): free text by its own rule; a quoted URL, or a
 * word's URL that is the whole unit, at `&` or `#` only; any other word's URL as a shell word ends it.
 */
function valueRule(input: { unit: string; at: number; opening: Opening; context: UnitContext; whole: boolean }): ValueRule {
  if (input.context === 'text') return VALUE_RULES.text
  if (input.opening.quoted) return input.unit[input.at - 1] === '"' ? VALUE_RULES.doubleQuoted : VALUE_RULES.url
  return input.whole ? VALUE_RULES.url : VALUE_RULES.shell
}

function openingAt(unit: string, at: number, next: NextIndex): Opening {
  const before = unit[at - 1]
  if (before !== undefined && QUOTES.has(before) && (at === 1 || OPENS_AFTER.test(unit[at - 2]!))) {
    const close = next(before, at)
    const line = next('\n', at)
    if (close >= 0 && (line < 0 || close < line)) return { limit: close, quoted: true }
  }
  const closer = before === undefined ? undefined : BRACKET_CLOSER[before]
  return closer === undefined ? { limit: unit.length, quoted: false } : { limit: unit.length, quoted: false, closer }
}

/**
 * Whether the character at an index ends a URL no quote opened: whitespace, the bracket that closes the one that
 * opened it, and in text `<`, `>`, `|`, a backtick, `$(`, a bracket the URL did not open and a `,` or `;` before
 * whitespace or the end. One per URL: it counts the brackets the URL opens, across its authority and the rest.
 */
function endsOf(unit: string, opening: Opening, context: UnitContext): (index: number) => boolean {
  let depth = 0
  return (index) => {
    const character = unit[index]!
    if (SPACE.test(character)) return true
    if (context === 'word') {
      if (opening.closer === undefined) return false
      if (character === opening.closer) return depth-- === 0
      if (BRACKET_CLOSER[character] === opening.closer) depth++
      return false
    }
    if (TEXT_ENDS.has(character) || (character === '$' && unit[index + 1] === '(')) return true
    if (OPEN_BRACKETS.has(character)) depth++
    if (CLOSE_BRACKETS.has(character) || character === opening.closer) return depth-- === 0
    return (character === ',' || character === ';') && (index + 1 === unit.length || SPACE.test(unit[index + 1]!))
  }
}

/** A URL's authority, up to `/`, `?` or `#`, and where its userinfo's last `@` is. Only a quoted URL in text holds a space. */
function scanAuthority(input: { unit: string; from: number; opening: Opening; context: UnitContext; ends: (index: number) => boolean }): { end: number; lastAt: number } {
  const { unit, opening } = input
  let lastAt = -1
  let index = input.from
  for (; index < opening.limit; index++) {
    const character = unit[index]!
    if (character === '/' || character === '?' || character === '#') break
    // Owner default N2 (a): in free text a `,` ends the authority, so `https://pay.example.com,1000000,x@y.com` shows.
    if (character === ',' && input.context === 'text') break
    if (opening.quoted ? SPACE.test(character) && input.context === 'word' : input.ends(index)) break
    if (character === '@') lastAt = index
  }
  return { end: index, lastAt }
}

/** Where the rest of a URL (path, query, fragment) ends: its closing quote, or the context's own end; in text a quote ends it too. */
function scanRest(input: { unit: string; from: number; opening: Opening; context: UnitContext; ends: (index: number) => boolean }): number {
  const { unit, opening } = input
  if (opening.quoted) return opening.limit
  let index = input.from
  while (index < opening.limit && !input.ends(index) && !(input.context === 'text' && QUOTES.has(unit[index]!))) index++
  return index
}

/**
 * The value of each credential parameter (`?`, `&`, `#` or `;`, a name, `=`) between `from` and `end`, ended as its
 * rule ends it (valueRule). A parameter that names no credential is read through, so one inside its value is still
 * met; the end found for one value is kept for the next that starts before it, so the scan stays linear.
 */
function parameterRanges(input: { text: string; from: number; end: number; ranges: Range[]; rule: ValueRule }): void {
  const { text, end } = input
  if (input.from >= end) return
  const { ends, substitution: substitutionEnds } = input.rule
  let knownFrom = -1
  let knownEnd = -1
  const named = new Map<string, boolean>()
  let index = input.from
  while (index < end) {
    if (!PARAMETER_SEPARATORS.has(text[index]!)) {
      index++
      continue
    }
    let cursor = index + 1
    while (cursor < end && !NAME_ENDS.has(text[cursor]!)) cursor++
    if (cursor >= end || text[cursor] !== '=' || cursor === index + 1) {
      index = cursor
      continue
    }
    const name = text.slice(index + 1, cursor)
    const start = cursor + 1
    let credential = named.get(name)
    if (credential === undefined) named.set(name, credential = isCredentialParameter(name))
    if (!credential) {
      index = start
      continue
    }
    if (!(knownFrom <= start && start <= knownEnd)) {
      knownFrom = start
      knownEnd = start
      while (knownEnd < end && !ends.has(text[knownEnd]!) && !(substitutionEnds && text[knownEnd] === '$' && text[knownEnd + 1] === '(')) knownEnd++
    }
    const valueEnd = knownEnd
    const value = text.slice(start, valueEnd)
    const kept = value.length - trailingPunctuation(value).length
    if (isCredentialParameter(name, value.slice(0, kept))) {
      input.ranges.push({ start, end: start + kept })
      index = valueEnd
    } else index = start
  }
}

// A backward scan: an anchored regex such as /[).]+$/ retries from every position of a long punctuation run.
function trailingPunctuation(value: string): string {
  let end = value.length
  while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1]!)) end -= 1
  return value.slice(end)
}

function redactJson(text: string): string | null {
  if (!JSON_DOCUMENT.test(text)) return null
  try {
    JSON.parse(text)
  } catch {
    return null
  }
  let shown = ''
  let cursor = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue
    const end = closingQuote(text, index)
    const value = JSON.parse(text.slice(index, end + 1)) as string
    const redacted = redactRanges(value, urlRanges(value, 'word'))
    if (redacted !== value) {
      shown += `${text.slice(cursor, index)}${JSON.stringify(redacted)}`
      cursor = end + 1
    }
    index = end
  }
  return shown + text.slice(cursor)
}

function closingQuote(text: string, open: number): number {
  let index = open + 1
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1
  return index
}

function redactRanges(text: string, ranges: Range[]): string {
  if (ranges.length === 0) return text
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  let shown = ''
  let cursor = 0
  let current = { ...sorted[0]! }
  for (const range of sorted.slice(1)) {
    if (range.start <= current.end) {
      current.end = Math.max(current.end, range.end)
      continue
    }
    shown += `${text.slice(cursor, current.start)}${REDACTED}`
    cursor = current.end
    current = { ...range }
  }
  return `${shown}${text.slice(cursor, current.start)}${REDACTED}${text.slice(current.end)}`
}
