import type { NormalizedError } from './types.js'

export interface SanitizeOptions {
  maxStringBytes: number
  maxDepth: number
  maxArrayItems: number
  allowKeys: ReadonlySet<string>
}

const REDACTED = '[redacted]'
// Keys whose values are credentials.
const SECRET_KEY = /authorization|cookie|token|secret|password|passphrase|api[-_]?key|credential|private[-_]?key|signature/i
// Keys whose values are file contents or full tool payloads.
const CONTENT_KEY = /^(content|contents|file[-_]?contents?|body|payload|arguments|args|tool[-_]?(input|output)|stdin|stdout|stderr|data)$/i
// Bearer/Basic headers, JWTs, sk-/ghp-style keys and long hex secrets inside free text.
const SECRET_VALUE = /\b(?:Bearer|Basic)\s+[\w.~+/=-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][\w-]{10,}|\b[a-fA-F0-9]{32,}\b/g
// Long opaque base64-like runs; redacted only when they mix letters and digits, so prose survives.
const OPAQUE_VALUE = /[A-Za-z0-9+/_-]{40,}={0,2}/g

const HAS_DIGIT = /\d/
const HAS_LETTER = /[A-Za-z]/
// Slack beyond the byte limit so a secret straddling the cut is still matched whole before truncation.
const REDACTION_SLACK_BYTES = 512

export function redactText(text: string): string {
  return text.replace(SECRET_VALUE, REDACTED).replace(OPAQUE_VALUE, match => (HAS_DIGIT.test(match) && HAS_LETTER.test(match) ? REDACTED : match))
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
  return sanitizeObject(fields, options, 0, new WeakSet())
}

function sanitizeValue(key: string, value: unknown, options: SanitizeOptions, depth: number, seen: WeakSet<object>): unknown {
  if (!options.allowKeys.has(key)) {
    if (SECRET_KEY.test(key)) return REDACTED
    if (CONTENT_KEY.test(key) && value !== undefined && value !== null) return `[omitted ${describeSize(value)}]`
  }
  if (typeof value === 'string') return sanitizeString(value, options)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (value instanceof Error) return normalizeError(value, options)
  if (value instanceof Date) return value.toISOString()
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth >= options.maxDepth) return '[max depth]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, options.maxArrayItems).map(item => sanitizeValue(key, item, options, depth + 1, seen))
    return value.length > options.maxArrayItems ? [...items, `[${value.length - options.maxArrayItems} more items]`] : items
  }
  return sanitizeObject(value as Record<string, unknown>, options, depth + 1, seen)
}

function sanitizeObject(value: Record<string, unknown>, options: SanitizeOptions, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) result[key] = sanitizeValue(key, item, options, depth, seen)
  return result
}

function describeSize(value: unknown): string {
  if (typeof value === 'string') return `${Buffer.byteLength(value)} bytes`
  if (value instanceof Uint8Array) return `${value.byteLength} bytes`
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
