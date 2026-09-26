import type { NormalizedError } from './types.js'

export interface SanitizeOptions {
  maxStringBytes: number
  maxDepth: number
  maxArrayItems: number
  maxObjectKeys: number
  allowKeys: ReadonlySet<string>
  omitKeys: ReadonlySet<string>
}

const REDACTED = '[redacted]'
// Key words whose values are credentials; keys are split into words, so inputTokens is not a token.
const SECRET_WORDS = new Set(['authorization', 'auth', 'cookie', 'token', 'secret', 'password', 'passphrase', 'passwd', 'credential', 'credentials', 'signature', 'apikey', 'privatekey'])
const SECRET_WORD_PAIRS = new Set(['api key', 'private key'])
// Keys whose values are file contents or full tool payloads.
const CONTENT_KEY = /^(content|contents|file[-_]?contents?|body|payload|arguments|args|tool[-_]?(input|output)|stdin|stdout|stderr|data)$/i
// Bearer/Basic headers, JWTs, sk-/ghp-style keys and hex runs of 32+ characters inside free text.
const SECRET_VALUE = /\b(?:Bearer|Basic)\s+[\w.~+/=-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][\w-]{10,}|\b[a-fA-F0-9]{32,}\b/g
// Long opaque base64-like runs; redacted only when they mix letters and digits, so prose survives. No `/`, so paths survive.
const OPAQUE_VALUE = /[A-Za-z0-9+_-]{40,}={0,2}/g
// A 40-character hex run is a git SHA-1, kept unless its key is secret-named.
const GIT_SHA = /^[a-f0-9]{40}$/i
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/g

const HAS_DIGIT = /\d/
const HAS_LETTER = /[A-Za-z]/
// Slack beyond the byte limit so a secret straddling the cut is still matched whole before truncation.
const REDACTION_SLACK_BYTES = 512

export function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.some((word, index) => SECRET_WORDS.has(word) || SECRET_WORD_PAIRS.has(`${word} ${words[index + 1]}`))
}

export function redactText(text: string): string {
  return redactUrls(text)
    .replace(SECRET_VALUE, match => (GIT_SHA.test(match) ? match : REDACTED))
    .replace(OPAQUE_VALUE, match => (!GIT_SHA.test(match) && HAS_DIGIT.test(match) && HAS_LETTER.test(match) ? REDACTED : match))
}

// Secret-named query parameters and userinfo passwords inside any URL in the text.
function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    let url: URL
    try { url = new URL(match) } catch { return match }
    let changed = false
    if (url.password) {
      url.password = REDACTED
      changed = true
    }
    for (const name of [...url.searchParams.keys()]) {
      if (!isSecretKey(name)) continue
      url.searchParams.set(name, REDACTED)
      changed = true
    }
    return changed ? url.toString() : match
  })
}

function sliceBytes(text: string, maxBytes: number): string {
  return Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/�$/, '')
}

export function sanitizeString(text: string, options: SanitizeOptions): string {
  const totalBytes = Buffer.byteLength(text)
  if (totalBytes <= options.maxStringBytes) return redactText(text)
  const head = redactText(sliceBytes(text, options.maxStringBytes + REDACTION_SLACK_BYTES))
  return `${sliceBytes(head, options.maxStringBytes)}...[truncated ${totalBytes - options.maxStringBytes} bytes]`
}

export function sanitizeFields(fields: Record<string, unknown>, options: SanitizeOptions): Record<string, unknown> {
  return sanitizeObject(Object.entries(fields), options, 0, new WeakSet())
}

function sanitizeValue(key: string, value: unknown, options: SanitizeOptions, depth: number, seen: WeakSet<object>): unknown {
  if (!options.allowKeys.has(key)) {
    if (isSecretKey(key)) return REDACTED
    if ((CONTENT_KEY.test(key) || options.omitKeys.has(key)) && value !== undefined && value !== null) return `[omitted ${describeSize(value)}]`
  }
  if (typeof value === 'string') return sanitizeString(value, options)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (value instanceof Error) return normalizeError(value, options)
  if (value instanceof Date) return value.toISOString()
  if (value === null || typeof value !== 'object') return value
  if (isByteView(value)) return `[omitted ${value.byteLength} bytes]`
  if (seen.has(value)) return '[circular]'
  if (depth >= options.maxDepth) return '[max depth]'
  seen.add(value)
  if (value instanceof Headers) return sanitizeObject([...value.entries()], options, depth + 1, seen)
  if (Array.isArray(value)) return sanitizeArray(key, value, options, depth, seen)
  return sanitizeObject(Object.entries(value), options, depth + 1, seen)
}

function sanitizeArray(key: string, value: unknown[], options: SanitizeOptions, depth: number, seen: WeakSet<object>): unknown[] {
  const items = value.slice(0, options.maxArrayItems).map(item => (isNamedPair(item) ? sanitizePair(item, options, depth, seen) : sanitizeValue(key, item, options, depth + 1, seen)))
  return value.length > options.maxArrayItems ? [...items, `[${value.length - options.maxArrayItems} more items]`] : items
}

// Header tuples such as [['x-api-key', '...']] are judged by their name, like object keys.
function isNamedPair(item: unknown): item is [string, unknown] {
  return Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'
}

function sanitizePair([name, value]: [string, unknown], options: SanitizeOptions, depth: number, seen: WeakSet<object>): [string, unknown] {
  return [sanitizeString(name, options), sanitizeValue(name, value, options, depth + 1, seen)]
}

function sanitizeObject(entries: [string, unknown][], options: SanitizeOptions, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, options.maxObjectKeys)) result[key] = sanitizeValue(key, item, options, depth, seen)
  if (entries.length > options.maxObjectKeys) result['[truncated]'] = `[${entries.length - options.maxObjectKeys} more keys]`
  return result
}

function isByteView(value: object): value is ArrayBufferLike | ArrayBufferView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer
}

function describeSize(value: unknown): string {
  if (typeof value === 'string') return `${Buffer.byteLength(value)} bytes`
  if (typeof value === 'object' && value !== null && isByteView(value)) return `${value.byteLength} bytes`
  return typeof value
}

export function normalizeError(error: unknown, options: SanitizeOptions, depth = 0): NormalizedError {
  if (!(error instanceof Error)) return { name: 'NonError', message: sanitizeString(String(error), options) }
  const code = (error as { code?: unknown }).code
  const normalized: NormalizedError = {
    name: error.name,
    message: sanitizeString(error.message, options),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(error.stack ? { stack: sanitizeString(error.stack, options) } : {}),
  }
  if (depth < 3 && error.cause !== undefined) normalized.cause = normalizeError(error.cause, options, depth + 1)
  if (depth < 3 && error instanceof AggregateError) normalized.errors = error.errors.slice(0, options.maxArrayItems).map(item => normalizeError(item, options, depth + 1))
  return normalized
}
