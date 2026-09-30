import { createHash } from 'node:crypto'
import { isCredentialKey, redactUrlParameters } from '@5straps/runtime'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { isSecretName } from './environment.js'

const MAX_STRING_LENGTH = 200
const MAX_ARRAY_ITEMS = 20
const MAX_DEPTH = 6

/**
 * Trims tool arguments to what an auditor needs. Paths, commands and URLs stay readable, while
 * file contents and anything named like a credential never reach the log.
 */
export function redactArguments(value: JsonValue): JsonValue {
  return redact(value, 0)
}

function redact(value: JsonValue, depth: number): JsonValue {
  if (depth >= MAX_DEPTH) return '[nested]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return redactArray(value, depth)
  if (value !== null && typeof value === 'object') return redactObject(value, depth)
  return value
}

function redactString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `[${value.length} characters]` : value
}

function redactArray(value: JsonValue[], depth: number): JsonValue {
  const kept = value.slice(0, MAX_ARRAY_ITEMS).map(item => redact(item, depth + 1))
  if (value.length <= MAX_ARRAY_ITEMS) return kept
  return [...kept, `[${value.length - MAX_ARRAY_ITEMS} more]`]
}

function redactObject(value: JsonObject, depth: number): JsonValue {
  const result: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSecretName(key) ? '[redacted]' : redact(item ?? null, depth + 1)
  }
  return result
}

/** Audit keeps argument shape; arbitrary strings can contain credentials even under innocent keys. */
export function redactAuditArguments(value: JsonValue, depth = 0): JsonValue {
  if (depth >= MAX_DEPTH) return '[nested]'
  if (typeof value === 'string') return `[${value.length} characters]`
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(item => redactAuditArguments(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
      key.slice(0, 100), isSecretName(key) ? '[redacted]' : redactAuditArguments(item ?? null, depth + 1),
    ]))
  }
  return value
}

/**
 * Removes a credential from text on its way out. Process output and upstream error bodies are
 * written by something Buckle does not control, so the token is stripped rather than trusted
 * to be absent.
 */
export function stripSecret(value: string, secret: string | undefined): string {
  if (!secret) return value
  return value.split(secret).join('[redacted]')
}

/** Longest string an approval challenge shows whole; a longer one keeps its head, its length and its sha256. */
const SHOWN_STRING_LENGTH = 1_024
const SHOWN_HEAD_LENGTH = 256
/** What one challenge's arguments may take; past it every string is cut to a short head, and past that only the size shows. */
const SHOWN_BYTES = 64 * 1_024
const SHORT_STRING_LENGTH = 64
/** Keys whose strings name a path: shown whole at every tier, since a cut path could hide where a call lands. */
const PATH_KEY = /^(?:path|paths|cwd|repo|root|directory)$/i
/**
 * A URL's userinfo (`scheme://user:password@`), which carries a credential whatever key holds the URL. It
 * runs to the last `@` of the authority, so a password holding an `@` is redacted whole (review L7 of the
 * second proof-of-possession re-review).
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,63}:\/\/)[^\s/?#]*@/gi
/** A URL with a scheme, up to whitespace or a quote: where a query can carry a credential parameter. */
const SCHEME_URL = /\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s"'<>]*/gi

/**
 * A string as a person reviewing a call may see it: every URL's userinfo, and the value of every
 * credential parameter in its query or fragment (the logger's matcher), redacted. The shown arguments
 * and the description Buckle writes both pass through it, so neither shows what the other hides
 * (review M2 of the second proof-of-possession re-review).
 */
export function redactShownText(value: string): string {
  return value.replace(URL_USERINFO, '$1[redacted]@').replace(SCHEME_URL, url => redactUrlParameters(url))
}

/** A call's arguments as a challenge shows them, and whether any part of them is left out. */
export interface ReviewableArguments {
  arguments: JsonValue
  /** A string was cut to its head, length and sha256, or the whole call replaced by its size and sha256 (review item 7). */
  truncated: boolean
}

/**
 * A call's arguments as an approval challenge shows them (owner decision D9): canonical, every value
 * under a credential-named key, every URL's userinfo and credential parameter redacted, with the logger's own matcher
 * (review item 8), and very long strings cut to a head, their length and their sha256, so a person's
 * device can show the raw action. A path is never cut. Display only: a decision binds the call's whole
 * arguments through its fingerprint, not this.
 */
export function reviewableArguments(args: JsonObject): ReviewableArguments {
  for (const limit of [SHOWN_STRING_LENGTH, SHORT_STRING_LENGTH]) {
    const cut = { truncated: false }
    const shown = review(args, { limit, cut, path: false })
    if (Buffer.byteLength(JSON.stringify(shown)) <= SHOWN_BYTES) return { arguments: shown, truncated: cut.truncated }
  }
  const whole = JSON.stringify(args)
  return { arguments: `[arguments of ${Buffer.byteLength(whole)} bytes, sha256 ${sha256(whole)}]`, truncated: true }
}

function review(value: JsonValue, input: { limit: number; cut: { truncated: boolean }; path: boolean }): JsonValue {
  if (typeof value === 'string') {
    const shown = redactShownText(value)
    if (input.path || shown.length <= input.limit) return shown
    input.cut.truncated = true
    return `${shown.slice(0, Math.min(input.limit, SHOWN_HEAD_LENGTH))}... [${value.length} characters, sha256 ${sha256(value)}]`
  }
  if (Array.isArray(value)) return value.map(item => review(item, input))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      const item = value[key] ?? null
      return [key, isCredentialKey(key, item) ? '[redacted]' : review(item, { ...input, path: PATH_KEY.test(key) })]
    }))
  }
  return value
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
