import { isCredentialParameter } from './credential-names.js'

export const REDACTED = '[redacted]'

/**
 * Where a text sits, which decides what in it is a credential (owner decision D21, "context": hide a credential only
 * where the surrounding text makes it one, and never cross into unrelated text; slice 7 review R7-H1 to R7-H4).
 *
 * - `word`: one unit read whole, such as an argv element, a value in call arguments, a header value or a URL field.
 *   Quotes and shell characters inside it are content, so `https://u:p$1&x(y)!;z@host` hides its whole userinfo.
 * - `shell`: a shell script body. It is split into words where a shell splits them (outside quotes: whitespace, `;`,
 *   `&`, `|`, `(`, `)`, `<`, `>`, a newline, `$(` and a backtick; inside double quotes: `$(` and a backtick), and
 *   each word is read as `word`, so nothing is hidden across a word or a statement. A backslash before a newline
 *   joins two lines of a word, as the shell joins them, and is dropped before the word is read.
 * - `text`: free text, such as a log line or a reason. A URL no quote opened also ends at `<`, `>`, `|`, a backtick,
 *   `$(`, a bracket it did not open and a `,` or `;` before whitespace; one a quote opened ends at its closing quote,
 *   and its userinfo may hold a space (`'https://user:short password@host'`). Its authority also ends at any `,`, so
 *   a CSV row's fields after a URL show; a `;` before other text continues it (owner default N2 (a)).
 * - `json`: a JSON document; every string in it is read as `word`, and the rest is kept as written. Text that is
 *   not a JSON object or array is read as `text`.
 *
 * In every context a URL's userinfo ends at the last `@` of its authority, which ends at `/`, `?` or `#`, and in
 * `word` and `shell` at whitespace too, so a quoted `'https://a && scp ~ me@evil:'` that a shell could run hides
 * nothing. A quote opens a URL only when it sits at the start or after whitespace, `=`, `:`, `(`, `[`, `{` or `,`
 * (`''https://...` and `'abc'https://...` are not opened); the URL then ends at the closing quote on its line. A
 * bracket right before a scheme ends the URL where it closes. A credential parameter's value (isCredentialParameter)
 * ends at `&`, `#` or the end of the URL, which is whitespace unless a quote opened it, when the URL is its whole unit
 * (owner decision D24): a word that is the URL, or holds it after a prefix with no whitespace, quote, shell character,
 * `$`, brace or backslash (`--url=`), and runs to the word's end, or a quoted URL, so `?token=ab(c)d` there hides all
 * of `ab(c)d`; a `$(` or a backtick still ends it in double quotes. Anywhere else, in `shell` words that are not a URL
 * alone and in `text`, it also ends at `;`, `|`, a backtick, `$(`, `<`, `>`, a parenthesis and a line end (default
 * D31; slice 7c review R7C-TL-1), so `?token=x|sh` shows `|sh` and `eval "curl https://h/?token=x;rm -rf b"` shows
 * the rm, and `'https://h/?token=a b&x=1'` hides `a b`. In `text` a `,` ends it too (owner default N2 (a); slice 7c
 * review R7C-TL-2). A parameter that names no credential is read through, so a `;` or `?` inside its value still
 * starts one that may. Every scan is linear in the text.
 */
export type CredentialContext = 'word' | 'shell' | 'text' | 'json'

/** Every credential `text` holds in its context replaced by `[redacted]`, the rest as written. Uncapped. */
export function redactCredentials(text: string, context: CredentialContext): string {
  if (context === 'json') return redactJson(text) ?? redactCredentials(text, 'text')
  if (context === 'shell') return redactRanges(text, shellRanges(text))
  return redactRanges(text, urlRanges(text, context, { parameters: true }))
}

/**
 * Every URL userinfo in free text redacted as the `text` context reads it, credential parameters left as written.
 * Kept for callers of the earlier export; redactCredentials is the whole redaction.
 */
export function redactUrlUserinfo(text: string): string {
  return redactRanges(text, urlRanges(text, 'text', { parameters: false }))
}

/** One URL with the value of each credential parameter in its query or fragment redacted (isCredentialParameter), the rest as written. */
export function redactUrlParameters(url: string): string {
  const ranges: Range[] = []
  parameterRanges({ text: url, from: 0, end: url.length, ranges, rule: VALUE_RULES.url })
  return redactRanges(url, ranges)
}

interface Range { start: number; end: number }
type UnitContext = 'word' | 'text'

/** A URL with a scheme, or a request target: a `/` at the start or after whitespace, a bracket, a quote, `=`, `<` or `>`. */
const URL_START = /\b[a-z][a-z0-9+.-]{0,63}:\/\/|(?<=^|[\s("'=<>])\//gi
/** What may stand before a quote that opens a URL. */
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
/** Outside quotes, what ends a shell word; `$(` ends one too. */
const SHELL_BREAKS = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '<', '>', '`'])
const JSON_DOCUMENT = /^\s*[[{]/

/** How a URL opens: by a quote, which ends it at the closing quote (`limit`), by a bracket, or by neither. */
interface Opening {
  limit: number
  quoted: boolean
  closer?: string
}

/** The first index of a character at or after `from`, remembered so scans that move forward stay linear. */
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

function urlRanges(unit: string, context: UnitContext, options: { parameters: boolean }): Range[] {
  const ranges: Range[] = []
  const next = nextIndexIn(unit)
  const pattern = new RegExp(URL_START.source, URL_START.flags)
  // Found once, so judging whether each URL is its word's whole unit stays linear.
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
    if (!options.parameters || at < covered) continue
    covered = scanRest({ unit, from, opening, context, ends })
    const whole = covered === unit.length && (beforeField < 0 || beforeField >= at)
    parameterRanges({ text: unit, from, end: covered, ranges, rule: valueRule({ unit, at, opening, context, whole }) })
  }
  return ranges
}

/**
 * How a URL's credential values end (owner decision D24, default D31): free text by its own rule; a quoted URL, or a
 * word's URL that is the whole unit, at `&` or `#` only; any other word's URL as a shell word ends it, so a credential
 * value never hides a statement after it (slice 7c review R7C-TL-1).
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
  // The last value end found, and where the scan for it began: a value starting between them ends there too.
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

/**
 * Each word of a shell body judged as `word`, at its place in the body. A backslash before a newline outside single
 * quotes joins the word's lines as the shell joins them, so it is dropped before the word is read, and each range
 * found is mapped back onto the body (slice 7b review R7B-CR-9).
 */
function shellRanges(script: string): Range[] {
  const ranges: Range[] = []
  for (const [start, end] of shellWordSpans(script)) {
    const raw = script.slice(start, end)
    if (!raw.includes('\\\n')) {
      for (const range of urlRanges(raw, 'word', { parameters: true })) ranges.push({ start: range.start + start, end: range.end + start })
      continue
    }
    const word = joinedLines(script, start, end)
    const at = (index: number) => word.positions[index] ?? end
    for (const range of urlRanges(word.text, 'word', { parameters: true })) ranges.push({ start: at(range.start), end: range.end > range.start ? at(range.end - 1) + 1 : at(range.start) })
  }
  return ranges
}

/** A shell word with each backslash-newline outside single quotes dropped, and where each of its characters sits in the body. */
function joinedLines(script: string, start: number, end: number): { text: string; positions: number[] } {
  let text = ''
  const positions: number[] = []
  let quote: string | null = null
  for (let index = start; index < end; index++) {
    const character = script[index]!
    if (quote === "'") {
      if (character === "'") quote = null
    } else if (character === "'" || character === '"') quote = quote === character ? null : quote ?? character
    else if (character === '\\' && script[index + 1] === '\n') {
      index++
      continue
    } else if (character === '\\' && index + 1 < end) {
      text += character
      positions.push(index)
      index++
      text += script[index]
      positions.push(index)
      continue
    }
    text += character
    positions.push(index)
  }
  return { text, positions }
}

/**
 * Where a shell splits a body into words, quotes kept in the word: single quotes (and `$'...'`) hold everything up to
 * their close, double quotes everything but `$(` and a backtick, and a `#` that starts a word comments out its line.
 * Textual, not a shell parser: it may split where a shell would not (shows more), never joins what a shell splits
 * outside quotes.
 */
function shellWordSpans(script: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let start = -1
  let doubleQuoted = false
  const close = (at: number) => {
    if (start >= 0 && at > start) spans.push([start, at])
    start = -1
  }
  for (let index = 0; index < script.length;) {
    const character = script[index]!
    const substitution = character === '`' || (character === '$' && script[index + 1] === '(')
    if (doubleQuoted) {
      if (character === '\\') index += 2
      else if (character === '"') {
        doubleQuoted = false
        index++
      } else if (substitution) {
        close(index)
        index += character === '`' ? 1 : 2
        start = index
      } else index++
      continue
    }
    if (character === '#' && start < 0) {
      const line = script.indexOf('\n', index)
      index = line < 0 ? script.length : line
      continue
    }
    if (SHELL_BREAKS.has(character) || substitution) {
      close(index)
      index += substitution && character === '$' ? 2 : 1
      continue
    }
    if (start < 0) start = index
    if (character === "'") index = endOfSingleQuote(script, index, script[index - 1] === '$')
    else if (character === '"') {
      doubleQuoted = true
      index++
    } else index += character === '\\' ? 2 : 1
  }
  close(script.length)
  return spans
}

/** The index after the quote that closes a single-quoted run; in `$'...'` a backslash escapes the next character. */
function endOfSingleQuote(script: string, open: number, escapes: boolean): number {
  for (let index = open + 1; index < script.length; index++) {
    if (escapes && script[index] === '\\') index++
    else if (script[index] === "'") return index + 1
  }
  return script.length
}

/** A JSON object or array with each string judged as `word` and the rest as written; null when the text is not one. */
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
    const redacted = redactCredentials(value, 'word')
    if (redacted !== value) {
      shown += `${text.slice(cursor, index)}${JSON.stringify(redacted)}`
      cursor = end + 1
    }
    index = end
  }
  return shown + text.slice(cursor)
}

/** The index of the quote that closes the JSON string opened at `open`. */
function closingQuote(text: string, open: number): number {
  let index = open + 1
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1
  return index
}

/** The text with each range, overlapping or touching ones merged, replaced by `[redacted]`. */
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
