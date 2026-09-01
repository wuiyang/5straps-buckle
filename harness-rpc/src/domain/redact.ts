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
