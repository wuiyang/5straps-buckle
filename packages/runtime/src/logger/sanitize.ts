import { REDACTED } from './credential-context.js'
import { redactLogCredentials } from './log-credentials.js'
import { isCredentialKey, keyWords } from './credential-names.js'
import type { NormalizedError } from './types.js'

export interface SanitizeOptions {
  maxStringBytes: number
  maxDepth: number
  maxArrayItems: number
  maxObjectKeys: number
  allowKeys: ReadonlySet<string>
  omitKeys: ReadonlySet<string>
}

// Longest string scanned; the rest is dropped with a truncation marker. Shared by the logger and redactText.
export const DEFAULT_MAX_STRING_BYTES = 8_192
// Keys whose values are file contents, full tool payloads, prompts or replies; also any key whose last word is one of
// CONTENT_LAST_WORDS (requestBody, systemPrompt, chatMessages). A singular 'message' stays: it is usually a diagnostic.
const CONTENT_KEY = /^(content|contents|file[-_]?contents?|body|payload|arguments|args|tool[-_]?(input|output)|stdin|stdout|stderr|data)$/i
const CONTENT_LAST_WORDS = new Set(['body', 'content', 'contents', 'payload', 'input', 'inputs', 'text', 'texts', 'prompt', 'prompts', 'messages'])
// Flat [name, value, name, value] header lists (IncomingMessage.rawHeaders) under a key ending in header(s).
const HEADER_LIST_WORD = /^headers?$/
// Bearer/Basic credentials: judged by the word before them, so over the whole text (review L10 of the second re-review).
const AUTHORIZATION_VALUE = /\b(?:Bearer|Basic)\s+[\w.~+/=-]+/g
// sk-/ghp-style keys and hex runs of 32+ characters inside free text.
const SECRET_VALUE = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][\w-]{10,}|\b[a-fA-F0-9]{32,}\b/g
// A JWT (eyJ header, then two '.'-separated segments). The header run is consumed atomically (lookahead plus
// backreference), so a long run without the dots is scanned once, not again from every 'eyJ' inside it.
const JWT_CANDIDATE = /\beyJ(?=([\w-]*))\1(\.[\w-]+\.[\w-]+)?/g
// Long base64-like runs. The slash is included so it cannot split an AWS or base64 secret; redactOpaqueRun keeps paths readable.
const OPAQUE_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g
const OPAQUE_MIN_LENGTH = 40
// A public key fingerprint (`SHA256:` and exactly 43 base64url characters, as ssh and Buckle's enrolled keys
// name them) identifies a key and holds nothing secret, so the log can say which device signed. It is set
// aside before the value passes run: an sk_, pk- or hex run inside one would otherwise be cut (review item 20).
// Only a whole one: no base64 character may touch it on either side, so a longer secret that starts or
// ends like one is judged whole (review L10 of the second re-review).
const KEY_FINGERPRINT = /(?<![A-Za-z0-9+/_-])SHA256:[A-Za-z0-9_-]{43}(?![A-Za-z0-9+/=_-])/g
const WORD_PIECE = /^(?:[a-z0-9]*|[A-Z0-9]+|[a-z]*[0-9]*(?:[A-Z][a-z]+[0-9]*)+)$/
const PIECE_SEPARATOR = /[/_-]/
// A bundler chunk name ends in a short hash after '-' or '_' (client-D3mGB526, src-STyD_Vvf).
const HASH_SUFFIX = /[-_][\w-]{1,12}$/
// A lowercase 40-character hex run reads as a git SHA-1, unless a credential word or an assignment sits just before it.
const GIT_SHA = /^[a-f0-9]{40}$/
// Only a complete generated checkpoint identifier, outside a credential context.
const CHECKPOINT_ID = /^change-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const IDENTIFIER_CONTEXT_CHARS = 32
const CREDENTIAL_NEARBY = /token|secret|passw(?:or)?d|passphrase|credential|cookie|signature|bearer|api[-_ ]?key|private[-_ ]?key|\b(?:pat|key|auth(?:orization)?)\b|=\s*$/i
const HAS_DIGIT = /\d/
const HAS_LETTER = /[A-Za-z]/
// Slack beyond the byte limit so a secret straddling the cut is still matched whole before truncation.
const REDACTION_SLACK_BYTES = 512

function isContentKey(key: string): boolean {
  return CONTENT_KEY.test(key) || CONTENT_LAST_WORDS.has(keyWords(key).at(-1) ?? '')
}

// Capped at DEFAULT_MAX_STRING_BYTES like a logged string, so no caller can make it scan an unbounded input.
export function redactText(text: string): string {
  return redactWithin(text, DEFAULT_MAX_STRING_BYTES)
}

function redactWithin(text: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text)
  if (totalBytes <= maxBytes) return redactSecrets(text)
  const head = redactSecrets(sliceBytes(text, maxBytes + REDACTION_SLACK_BYTES))
  return `${sliceBytes(head, maxBytes)}...[truncated ${totalBytes - maxBytes} bytes]`
}

// Every pattern is linear in the input: no pattern can backtrack over the rest of the text from each start.
// The passes that judge a value by what precedes it (URL userinfo and parameters, Bearer and Basic) run over
// the whole text first, so a fingerprint-shaped value there is a credential (review L10 of the second
// re-review); key fingerprints left after them pass through whole, and the text around them is redacted as usual.
function redactSecrets(text: string): string {
  const judged = redactContext(text)
  let redacted = ''
  let from = 0
  for (const fingerprint of judged.matchAll(KEY_FINGERPRINT)) {
    redacted += redactValues(judged.slice(from, fingerprint.index)) + fingerprint[0]
    from = fingerprint.index + fingerprint[0].length
  }
  return redacted + redactValues(judged.slice(from))
}

// A JSON message is judged string by string, any other text as free text (owner decision D21, "context").
function redactContext(text: string): string {
  return redactLogCredentials(text)
    .replace(JWT_CANDIDATE, (match: string, header: string, rest: string | undefined) => (header && rest ? REDACTED : match))
    .replace(AUTHORIZATION_VALUE, REDACTED)
}

function redactValues(text: string): string {
  return text
    .replace(SECRET_VALUE, (match: string, offset: number, whole: string) => (isGitSha({ match, before: whole.slice(Math.max(0, offset - IDENTIFIER_CONTEXT_CHARS), offset) }) ? match : REDACTED))
    .replace(OPAQUE_RUN, redactOpaqueRun)
}

function isGitSha({ match, before }: { match: string; before: string }): boolean {
  return GIT_SHA.test(match) && !CREDENTIAL_NEARBY.test(before)
}

// A path is judged segment by segment; any other run is judged whole, so a slash cannot split a secret.
function redactOpaqueRun(run: string, offset: number, whole: string): string {
  if (CHECKPOINT_ID.test(run)) {
    const before = whole.slice(0, offset).trimEnd().slice(-IDENTIFIER_CONTEXT_CHARS)
    if (!CREDENTIAL_NEARBY.test(before)) return run
  }
  if (!isPathShaped(run)) return isOpaque(run) ? REDACTED : run
  return run.split('/').map(segment => (isOpaque(segment) ? REDACTED : segment)).join('/')
}

// A '/' past any leading one, and every segment reads as words; a slash-led run with no other '/' is one value.
function isPathShaped(run: string): boolean {
  const segments = run.split('/')
  return segments.length > (run.startsWith('/') ? 2 : 1) && segments.every(segment => readsAsWords(segment.replace(HASH_SUFFIX, '')))
}

function readsAsWords(text: string): boolean {
  return text.split(PIECE_SEPARATOR).every(piece => WORD_PIECE.test(piece))
}

// Letters mixed with digits, or letters in no word shape; prose, long names and git SHAs survive.
function isOpaque(text: string): boolean {
  return text.length >= OPAQUE_MIN_LENGTH && !GIT_SHA.test(text) && HAS_LETTER.test(text) && (HAS_DIGIT.test(text) || !readsAsWords(text))
}

export function truncateText(text: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text)
  return totalBytes <= maxBytes ? text : `${sliceBytes(text, maxBytes)}...[truncated ${totalBytes - maxBytes} bytes]`
}

function sliceBytes(text: string, maxBytes: number): string {
  return Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '')
}

export function sanitizeString(text: string, options: SanitizeOptions): string {
  return redactWithin(text, options.maxStringBytes)
}

export function sanitizeFields(fields: Record<string, unknown>, options: SanitizeOptions): Record<string, unknown> {
  return sanitizeObject(Object.entries(fields), options, 0, new WeakSet())
}

function sanitizeValue(key: string, value: unknown, options: SanitizeOptions, depth: number, seen: WeakSet<object>): unknown {
  // No configuration lifts a credential key: allowKeys only exempts content and omitted keys.
  if (isCredentialKey(key, value)) return REDACTED
  if (!options.allowKeys.has(key) && (isContentKey(key) || options.omitKeys.has(key)) && value !== undefined && value !== null) return `[omitted ${describeSize(value)}]`
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
