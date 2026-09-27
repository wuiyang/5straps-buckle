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
// Credential words, matched inside each key word so plurals and run-together names (accesstoken, PGPASSWORD) count.
const SECRET_WORD = /authorization|token|secret|passw(?:or)?d|passphrase|cookie|credential|signature|apikey|privatekey/
const SECRET_WHOLE_WORDS = new Set(['auth'])
// Two-word names such as 'api key' and 'private keys'.
const KEY_PREFIXES = new Set(['api', 'private'])
const KEY_WORD = /^keys?$/
// Token counts, not credentials: a qualifier before token(s) or a count word after it (inputTokens, tokenCount, max_tokens).
const TOKEN_COUNT_QUALIFIERS = ['input', 'output', 'prompt', 'completion', 'total', 'max', 'min', 'cache', 'cached', 'reasoning', 'context', 'remaining', 'used']
const TOKEN_COUNT_SUFFIXES = ['count', 'counts', 'usage', 'limit', 'budget', 'total', 'used']
const TOKEN_WORD = /^tokens?$/
const RUN_TOGETHER_TOKEN_COUNT = new RegExp(`^(?:${TOKEN_COUNT_QUALIFIERS.join('|')})tokens?$|^tokens?(?:${TOKEN_COUNT_SUFFIXES.join('|')})$`)
// Keys whose values are file contents or full tool payloads; also any key whose last word is one of CONTENT_LAST_WORDS (requestBody).
const CONTENT_KEY = /^(content|contents|file[-_]?contents?|body|payload|arguments|args|tool[-_]?(input|output)|stdin|stdout|stderr|data)$/i
const CONTENT_LAST_WORDS = new Set(['body', 'content', 'contents', 'payload'])
// Flat [name, value, name, value] header lists (IncomingMessage.rawHeaders) under a key ending in header(s).
const HEADER_LIST_WORD = /^headers?$/
// Bearer/Basic headers, JWTs, sk-/ghp-style keys and hex runs of 32+ characters inside free text.
const SECRET_VALUE = /\b(?:Bearer|Basic)\s+[\w.~+/=-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][\w-]{10,}|\b[a-fA-F0-9]{32,}\b/g
// Long base64-like runs. The slash is included so it cannot split an AWS or base64 secret; redactOpaqueRun keeps paths readable.
const OPAQUE_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g
const OPAQUE_MIN_LENGTH = 40
// '+' or '=' padding only appear in encoded values, never in path segments.
const BASE64_MARK = /\+|=$/
const LOWER_TO_UPPER = /[a-z][A-Z]/g
// A lowercase 40-character hex run reads as a git SHA-1, unless a credential word or an assignment sits just before it.
const GIT_SHA = /^[a-f0-9]{40}$/
const SHA_CONTEXT_CHARS = 32
const CREDENTIAL_NEARBY = /token|secret|passw(?:or)?d|passphrase|credential|cookie|signature|bearer|api[-_ ]?key|private[-_ ]?key|\b(?:pat|key|auth)\b|=\s*$/i
// A URL with any scheme, or a request target starting with '/', up to whitespace or a quote.
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?<=^|[\s("'=<>])\/)[^\s"'<>]*/gi
const USERINFO_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)@/i
// name=value in a query or fragment; the value stops at the next separator.
const URL_PARAM = /([?&#;])([^=&#;?]+)=([^&#;]*)/g
const TRAILING_PUNCTUATION = /[).,;:!?]+$/
// Credential parameters whose names are not credential words: Google API keys, SAS signatures, OAuth codes.
const SECRET_QUERY_NAMES = new Set(['key', 'sig', 'code'])

const HAS_DIGIT = /\d/
const HAS_LETTER = /[A-Za-z]/
// Slack beyond the byte limit so a secret straddling the cut is still matched whole before truncation.
const REDACTION_SLACK_BYTES = 512

function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

export function isSecretKey(key: string): boolean {
  const words = keyWords(key)
  return words.some((word, index) => isSecretWord({ word, previous: words[index - 1], next: words[index + 1] }))
}

function isContentKey(key: string): boolean {
  return CONTENT_KEY.test(key) || CONTENT_LAST_WORDS.has(keyWords(key).at(-1) ?? '')
}

function isSecretWord({ word, previous, next }: { word: string; previous?: string; next?: string }): boolean {
  if (SECRET_WHOLE_WORDS.has(word)) return true
  if (KEY_PREFIXES.has(word) && next !== undefined && KEY_WORD.test(next)) return true
  return SECRET_WORD.test(word) && !isTokenCount({ word, previous, next })
}

function isTokenCount({ word, previous, next }: { word: string; previous?: string; next?: string }): boolean {
  if (RUN_TOGETHER_TOKEN_COUNT.test(word)) return true
  if (!TOKEN_WORD.test(word)) return false
  return (previous !== undefined && TOKEN_COUNT_QUALIFIERS.includes(previous)) || (next !== undefined && TOKEN_COUNT_SUFFIXES.includes(next))
}

export function redactText(text: string): string {
  return redactUrls(text)
    .replace(SECRET_VALUE, (match: string, offset: number, whole: string) => (isGitSha({ match, before: whole.slice(Math.max(0, offset - SHA_CONTEXT_CHARS), offset) }) ? match : REDACTED))
    .replace(OPAQUE_RUN, redactOpaqueRun)
}

function isGitSha({ match, before }: { match: string; before: string }): boolean {
  return GIT_SHA.test(match) && !CREDENTIAL_NEARBY.test(before)
}

// Absolute paths start with '/', and relative ones read as words; an encoded value mixes camel humps and digits throughout.
function redactOpaqueRun(run: string): string {
  if (!run.includes('/')) return isOpaque(run) ? REDACTED : run
  if (BASE64_MARK.test(run) && isOpaque(run)) return REDACTED
  if (!run.startsWith('/') && HAS_DIGIT.test(run) && (run.match(LOWER_TO_UPPER)?.length ?? 0) >= 2) return REDACTED
  return run.split('/').map(segment => (isOpaque(segment) ? REDACTED : segment)).join('/')
}

// Redacted only when letters and digits mix, so prose and long words survive.
function isOpaque(text: string): boolean {
  return text.length >= OPAQUE_MIN_LENGTH && !GIT_SHA.test(text) && HAS_DIGIT.test(text) && HAS_LETTER.test(text)
}

// Userinfo passwords and secret-named query or fragment parameters in any URL or request target.
// Only the secret value is rewritten, so the rest stays exactly as written.
function redactUrls(text: string): string {
  return text.replace(URL_LIKE, url => url.replace(USERINFO_PASSWORD, `$1${REDACTED}@`).replace(URL_PARAM, (pair, separator: string, name: string, value: string) => {
    if (!isSecretKey(name) && !SECRET_QUERY_NAMES.has(name.toLowerCase())) return pair
    const trailing = TRAILING_PUNCTUATION.exec(value)?.[0] ?? ''
    return `${separator}${name}=${REDACTED}${trailing}`
  }))
}

export function truncateText(text: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text)
  return totalBytes <= maxBytes ? text : `${sliceBytes(text, maxBytes)}...[truncated ${totalBytes - maxBytes} bytes]`
}

function sliceBytes(text: string, maxBytes: number): string {
  return Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '')
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
    if ((isContentKey(key) || options.omitKeys.has(key)) && value !== undefined && value !== null) return `[omitted ${describeSize(value)}]`
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
  if (isHeaderList(key, value)) return sanitizeHeaderList(value, options, depth, seen)
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

function isHeaderList(key: string, value: unknown): value is string[] {
  return Array.isArray(value) && value.length % 2 === 0 && HEADER_LIST_WORD.test(keyWords(key).at(-1) ?? '') && value.every(item => typeof item === 'string')
}

// Each value is judged by the header name before it.
function sanitizeHeaderList(value: string[], options: SanitizeOptions, depth: number, seen: WeakSet<object>): unknown[] {
  const headers = value.length / 2
  const kept = Array.from({ length: Math.min(headers, options.maxArrayItems) }, (_, index) => sanitizePair([value[index * 2]!, value[index * 2 + 1]], options, depth, seen)).flat()
  return headers > options.maxArrayItems ? [...kept, `[${headers - options.maxArrayItems} more headers]`] : kept
}

// Keys are text too: a secret used as a map key is redacted like any value.
function sanitizeObject(entries: [string, unknown][], options: SanitizeOptions, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, options.maxObjectKeys)) result[sanitizeString(key, options)] = sanitizeValue(key, item, options, depth, seen)
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
