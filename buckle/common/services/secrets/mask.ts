import { maskLabel, MIN_SECRET_LENGTH } from '../../domain/secret-reference.js'

/** One value a call's reference resolved to, by the NAME it is shown as. */
export interface SecretValue {
  name: string
  value: string
}

/**
 * Replaces every value a call resolved, and each common encoding of it, with `[secret:NAME]` wherever text leaves
 * Buckle (docs/secrets.md). `drop` forgets the values once the call has answered.
 */
export interface Masker {
  text(text: string): string
  /** Every string of a JSON value, keys included; a field of an object marked `truncated` is also cut where a value starts. */
  json<T>(value: T): T
  drop(): void
}

/** How short a value's start at the end of a text may be and still be masked, where the text was not cut short. */
const TAIL_SHORTEST = 4
/** How deep a value is walked when masked: deeper than any result a tool returns. */
const MAX_DEPTH = 64

interface Form { text: string; label: string }

/**
 * The forms a value is masked in: as it is, URL-encoded (encodeURIComponent, with `+` for a blank as a form posts it,
 * and with lower-case hex), base64 and base64url with and without padding, the base64 a value shows as when it starts
 * one or two bytes into a longer encoded run (the characters it alone decides), and as JSON escapes it. A form shorter
 * than MIN_SECRET_LENGTH is not masked, as it would mask ordinary text.
 */
export function maskForms(value: string): string[] {
  const forms = new Set<string>([value])
  const encoded = encodeURIComponent(value)
  forms.add(encoded)
  forms.add(encoded.replace(/%20/g, '+'))
  forms.add(encoded.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()))
  const bytes = Buffer.from(value, 'utf8')
  for (const base64 of [bytes.toString('base64'), bytes.toString('base64url')]) {
    forms.add(base64)
    forms.add(base64.replace(/=+$/, ''))
  }
  for (const offset of [0, 1, 2]) {
    const shifted = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64').replace(/=+$/, '')
    // The first characters also carry the bytes before the value, and the last may carry the bytes after it: only the
    // characters the value's own bits fill are its in every run.
    const start = Math.ceil((offset * 8) / 6)
    const end = Math.floor(((offset + bytes.length) * 8) / 6)
    const core = shifted.slice(start, end)
    forms.add(core)
    forms.add(core.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  forms.add(JSON.stringify(value).slice(1, -1))
  return [...forms].filter(form => form.length >= MIN_SECRET_LENGTH)
}

export function createMasker(values: readonly SecretValue[]): Masker {
  let forms: Form[] = values.flatMap(({ name, value }) => maskForms(value).map(text => ({ text, label: maskLabel(name) })))
  // The longest first, so a form holding another is masked whole.
  forms.sort((left, right) => right.text.length - left.text.length)
  const text = (input: string, cut = false): string => {
    if (forms.length === 0 || input.length === 0) return input
    let masked = input
    for (const form of forms) if (masked.includes(form.text)) masked = masked.split(form.text).join(form.label)
    masked = maskInViews(masked, forms)
    return maskTail(masked, forms, cut ? 1 : TAIL_SHORTEST)
  }
  return {
    text: input => text(input),
    json: value => walk(value, text, 0, new WeakSet()),
    drop: () => { forms = [] },
  }
}

/**
 * A text as an encoder's reader sees it: each character it shows, and the span of the text it was read from, `from`
 * inclusive and `to` exclusive.
 */
interface View {
  text: string
  from: Int32Array
  to: Int32Array
}

/**
 * Each form masked where a view of the text shows it, as an encoder that escapes other characters than
 * encodeURIComponent writes it (URLSearchParams, RFC 3986 as curl and jq write it, Python's quote): every span the
 * view reads the form from becomes its label, the longest form first and no span twice.
 */
function maskInViews(text: string, forms: readonly Form[]): string {
  // A `+` reads as a blank in a form and as itself elsewhere, so a text holding one is read both ways.
  const views = [decodedView(text, true), text.includes('+') ? decodedView(text, false) : null].filter((view): view is View => view !== null)
  if (views.length === 0) return text
  const spans: Array<{ from: number; to: number; label: string }> = []
  const taken = new Uint8Array(text.length)
  for (const form of forms) {
    for (const view of views) {
      for (let at = view.text.indexOf(form.text); at >= 0; at = view.text.indexOf(form.text, at + 1)) {
        const from = view.from[at]!
        const to = view.to[at + form.text.length - 1]!
        if (taken.subarray(from, to).includes(1)) continue
        taken.fill(1, from, to)
        spans.push({ from, to, label: form.label })
      }
    }
  }
  if (spans.length === 0) return text
  spans.sort((left, right) => left.from - right.from)
  let masked = ''
  let last = 0
  for (const span of spans) {
    masked += `${text.slice(last, span.from)}${span.label}`
    last = span.to
  }
  return masked + text.slice(last)
}

/**
 * The text with each percent-encoded UTF-8 character read as the character, and a `+` as a blank where `plusIsBlank`, as
 * a form's reader takes it; null where nothing in it reads otherwise.
 */
function decodedView(text: string, plusIsBlank: boolean): View | null {
  if (!text.includes('%') && !(plusIsBlank && text.includes('+'))) return null
  const from = new Int32Array(text.length)
  const to = new Int32Array(text.length)
  const parts: string[] = []
  let shown = 0
  let run = 0
  for (let index = 0; index < text.length;) {
    const escape = escapeAt(text, index, plusIsBlank)
    if (escape === null) {
      from[shown] = index
      to[shown] = index + 1
      shown += 1
      index += 1
      continue
    }
    parts.push(text.slice(run, index), escape.characters)
    for (let unit = 0; unit < escape.characters.length; unit++, shown++) {
      from[shown] = index
      to[shown] = index + escape.length
    }
    index += escape.length
    run = index
  }
  if (parts.length === 0) return null
  parts.push(text.slice(run))
  return { text: parts.join(''), from: from.subarray(0, shown), to: to.subarray(0, shown) }
}

interface Escape { characters: string; length: number }

const BLANK: Escape = { characters: ' ', length: 1 }

/** The escape that starts at `index`, as the character it writes and how long it is, or null where none starts. */
function escapeAt(text: string, index: number, plusIsBlank: boolean): Escape | null {
  const code = text.charCodeAt(index)
  if (code === 0x25) return percentEscape(text, index)
  if (code === 0x2b) return plusIsBlank ? BLANK : null
  return null
}

/** The byte a `%XX` at `index` writes, or -1. */
function percentByte(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x25) return -1
  const high = hexDigit(text.charCodeAt(index + 1))
  const low = hexDigit(text.charCodeAt(index + 2))
  return high < 0 || low < 0 ? -1 : high * 16 + low
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x37
  if (code >= 0x61 && code <= 0x66) return code - 0x57
  return -1
}

/** The one UTF-8 character a run of `%XX` at `index` writes, and how long the run is, or null where it writes none. */
function percentEscape(text: string, index: number): Escape | null {
  const lead = percentByte(text, index)
  if (lead < 0) return null
  if (lead < 0x80) return { characters: String.fromCharCode(lead), length: 3 }
  const size = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
  if (size === 0) return null
  const bytes = new Uint8Array(size)
  bytes[0] = lead
  for (let next = 1; next < size; next++) {
    const byte = percentByte(text, index + next * 3)
    if (byte < 0 || (byte & 0xc0) !== 0x80) return null
    bytes[next] = byte
  }
  try {
    return { characters: UTF8.decode(bytes), length: size * 3 }
  } catch {
    return null
  }
}

/** Refuses an overlong form or a surrogate, which no encoder writes for a character. */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The start of a value at the very end of a text, masked: where a stream is cut at its bound in the middle of a value,
 * the part before the cut is no longer the whole value. A replacement character a cut in a multibyte character left is
 * looked past.
 */
function maskTail(text: string, forms: readonly Form[], shortest: number): string {
  const body = text.replace(/\uFFFD+$/, '')
  for (const form of forms) {
    const from = Math.max(0, body.length - (form.text.length - 1))
    // Each place the form's first character stands in the last characters, the earliest (the longest start) first.
    for (let index = body.indexOf(form.text[0]!, from); index >= 0; index = body.indexOf(form.text[0]!, index + 1)) {
      if (body.length - index < shortest) break
      if (form.text.startsWith(body.slice(index))) return `${body.slice(0, index)}${form.label}${text.slice(body.length)}`
    }
  }
  return text
}

function walk<T>(value: T, text: (input: string, cut?: boolean) => string, depth: number, seen: WeakSet<object>): T {
  if (typeof value === 'string') return text(value) as T
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => walk(item, text, depth + 1, seen)) as T
  if (value instanceof Error) {
    const masked = new Error(text(value.message))
    masked.name = value.name
    masked.stack = value.stack === undefined ? undefined : text(value.stack)
    if ('code' in value) Object.assign(masked, { code: value.code })
    return masked as T
  }
  const cut = (value as Record<string, unknown>).truncated === true
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), typeof item === 'string' ? text(item, cut) : walk(item, text, depth + 1, seen)])) as T
}

/**
 * The values of every call that holds some now, so a log line any part of Buckle writes meanwhile is masked as the
 * call's own result is (docs/secrets.md). A call holds its masker from the moment it reads its values until it has
 * answered.
 */
const held = new Set<Masker>()

export function holdMasker(masker: Masker): () => void {
  held.add(masker)
  return () => { held.delete(masker) }
}

/** Whether any call holds values now; nothing is walked while none does. */
export function masksHeld(): boolean {
  return held.size > 0
}

/** Text with every value any call holds now masked. */
export function maskHeld(text: string): string {
  let masked = text
  for (const masker of held) masked = masker.text(masked)
  return masked
}

/** A value with every string in it masked by every value any call holds now. */
export function maskHeldJson<T>(value: T): T {
  let masked = value
  for (const masker of held) masked = masker.json(masked)
  return masked
}
