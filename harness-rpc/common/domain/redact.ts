import { isCredentialKey, redactUrlParameters, redactUrlUserinfo } from '@5straps/runtime'
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

/** A URL with a scheme, up to whitespace or a quote: where a query can carry a credential parameter. */
const SCHEME_URL = /\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s"'<>]*/gi

/**
 * A string as a person reviewing a call may see it: every URL's userinfo, and the value of every
 * credential parameter in its query or fragment (the logger's matcher), redacted. The shown arguments,
 * the description Buckle writes, a command's shown words and effects, and every approval reason pass
 * through it, so none shows what another hides (review M2 of the second proof-of-possession re-review;
 * owner decision D17).
 */
export function redactShownText(value: string): string {
  return redactUrlUserinfo(value).replace(SCHEME_URL, redactUrlParameters)
}

/**
 * A call's arguments as an approval challenge shows them (owner decisions D9 and D17): canonical, every
 * value under a credential-named key, every URL's userinfo and credential parameter redacted, with the
 * logger's own matcher (review item 8), and nothing else changed: no string, path or list is cut, and no
 * size stands in for the call. Display only: a decision binds the call's whole arguments through its
 * fingerprint, not this.
 */
export function reviewableArguments(args: JsonObject): JsonValue {
  return review(args)
}

function review(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactShownText(value)
  if (Array.isArray(value)) return value.map(review)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      const item = value[key] ?? null
      return [key, isCredentialKey(key, item) ? '[redacted]' : review(item)]
    }))
  }
  return value
}
