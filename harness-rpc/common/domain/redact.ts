import { createHash } from 'node:crypto'
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

/**
 * A call's arguments as an approval challenge shows them (owner decision D9): canonical, every value
 * under a credential-named key redacted, and very long strings cut to a head, their length and their
 * sha256, so a person's device can show the raw action. Display only: a proven decision binds the
 * call's whole arguments through its fingerprint, not this.
 */
export function reviewableArguments(args: JsonObject): JsonValue {
  const shown = review(args, SHOWN_STRING_LENGTH)
  if (Buffer.byteLength(JSON.stringify(shown)) <= SHOWN_BYTES) return shown
  const shorter = review(args, SHORT_STRING_LENGTH)
  if (Buffer.byteLength(JSON.stringify(shorter)) <= SHOWN_BYTES) return shorter
  const whole = JSON.stringify(args)
  return `[arguments of ${Buffer.byteLength(whole)} bytes, sha256 ${sha256(whole)}]`
}

function review(value: JsonValue, limit: number): JsonValue {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, Math.min(limit, SHOWN_HEAD_LENGTH))}... [${value.length} characters, sha256 ${sha256(value)}]` : value
  if (Array.isArray(value)) return value.map(item => review(item, limit))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, isSecretName(key) ? '[redacted]' : review(value[key] ?? null, limit)]))
  }
  return value
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
