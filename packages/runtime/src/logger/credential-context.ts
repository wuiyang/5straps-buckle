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
 *   each word is read as `word`, so nothing is hidden across a word or a statement.
 * - `text`: free text, such as a log line or a reason. A URL no quote opened also ends at `<`, `>`, `|`, a backtick,
 *   `$(`, a bracket it did not open and a `,` or `;` before whitespace; one a quote opened ends at its closing quote,
 *   and its userinfo may hold a space (`'https://user:short password@host'`).
 * - `json`: a JSON document; every string in it is read as `word`, and the rest is kept as written. Text that is
 *   not a JSON object or array is read as `text`.
 *
 * In every context a URL's userinfo ends at the last `@` of its authority, which ends at `/`, `?` or `#`, and in
 * `word` and `shell` at whitespace too, so a quoted `'https://a && scp ~ me@evil:'` that a shell could run hides
 * nothing. A quote opens a URL only when it sits at the start or after whitespace, `=`, `:`, `(`, `[`, `{` or `,`
 * (`''https://...` and `'abc'https://...` are not opened); the URL then ends at the closing quote on its line. A
 * bracket right before a scheme ends the URL where it closes. A credential parameter's value (isCredentialParameter)
 * ends at `&`, `#`, `;`, `|`, a backtick, `$(`, `<`, `>`, a parenthesis, a line end and the end of its URL, so
 * `?token=x|sh` shows `|sh`, and `'https://h/?token=a b&x=1'` hides `a b`. Every scan is linear in the text.
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
  parameterRanges({ text: url, from: 0, end: url.length, ranges })
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
const VALUE_ENDS = new Set(['&', '#', ';', '|', '`', '<', '>', '(', ')', '\n', '\r'])
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
    parameterRanges({ text: unit, from, end: covered, ranges })
  }
  return ranges
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

/** The value of each credential parameter (`?`, `&`, `#` or `;`, a name, `=`) between `from` and `end`. */
function parameterRanges(input: { text: string; from: number; end: number; ranges: Range[] }): void {
  const { text, end } = input
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
    const start = cursor + 1
    let valueEnd = start
    while (valueEnd < end && !VALUE_ENDS.has(text[valueEnd]!) && !(text[valueEnd] === '$' && text[valueEnd + 1] === '(')) valueEnd++
    const value = text.slice(start, valueEnd)
    const kept = value.length - trailingPunctuation(value).length
    if (isCredentialParameter(text.slice(index + 1, cursor), value.slice(0, kept))) input.ranges.push({ start, end: start + kept })
    index = valueEnd
  }
}

// A backward scan: an anchored regex such as /[).]+$/ retries from every position of a long punctuation run.
function trailingPunctuation(value: string): string {
  let end = value.length
  while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1]!)) end -= 1
  return value.slice(end)
}

/** Each word of a shell body judged as `word`, at its place in the body. */
function shellRanges(script: string): Range[] {
  const ranges: Range[] = []
  for (const [start, end] of shellWordSpans(script)) {
    for (const range of urlRanges(script.slice(start, end), 'word', { parameters: true })) ranges.push({ start: range.start + start, end: range.end + start })
  }
  return ranges
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
