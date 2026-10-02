import { isCredentialKey, redactCredentials, type CredentialContext } from '@5straps/runtime'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { baseCommand, shellBodyIndexes, SHELL_COMMANDS } from './argv.js'
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

/**
 * A call's arguments as an approval challenge shows them (owner decisions D9 and D17): canonical, every
 * value under a credential-named key redacted, every other string's credentials redacted by the context it
 * sits in (owner decision D21; redactCredentials), and nothing else changed: no string, path or list is cut,
 * and no size stands in for the call. Display only: a decision binds the call's whole arguments through its
 * fingerprint, not this.
 *
 * A string's context comes from where it sits: a `command` with its `args` is an argv, each word read as one
 * word and a shell's `-c` script as a shell body; `env` values are words; a `script` beside a shell `runtime`
 * is a shell body and any other script free text; a file's `content`, or an edit's `oldText` and `newText`,
 * beside its `path` is a shell body for a shell script, a JSON document when it parses as an object or array,
 * and free text otherwise, whatever its whitespace, so a one-line CSV row shows its fields (slice 7d review
 * R7D-WV-3). Any other string is read by its shape: a JSON document when it parses as an object or array, one
 * word when it holds no whitespace, and free text otherwise (slice 7 review R7-H1 to R7-H4).
 */
export function reviewableArguments(args: JsonObject): JsonValue {
  return reviewObject(args)
}

/** How a string is read: by a context, by its shape, or as a file's content. */
type Reading = CredentialContext | 'shape' | 'file'

function review(value: JsonValue, reading: Reading): JsonValue {
  if (typeof value === 'string') return redactCredentials(value, contextOf(value, reading))
  if (Array.isArray(value)) return value.map(item => review(item, reading))
  if (value !== null && typeof value === 'object') return reading === 'shape' ? reviewObject(value) : reviewRecord(value, reading)
  return value
}

function contextOf(value: string, reading: Reading): CredentialContext {
  if (reading === 'shape') return shapeOf(value)
  if (reading === 'file') return isJsonDocument(value) ? 'json' : 'text'
  return reading
}

function reviewObject(value: JsonObject): JsonValue {
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const item = value[key] ?? null
    if (isCredentialKey(key, item)) return [key, '[redacted]']
    if (key === 'args' && typeof value.command === 'string' && Array.isArray(item)) return [key, reviewArgv(value.command, item)]
    return [key, review(item, readingOf(value, key))]
  }))
}

/** An object whose values are all read in one context (`env`'s values are words, an edit's texts are file content), credential-named keys still redacted. */
function reviewRecord(value: JsonObject, reading: Exclude<Reading, 'shape'>): JsonValue {
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const item = value[key] ?? null
    return [key, isCredentialKey(key, item) ? '[redacted]' : review(item, reading)]
  }))
}

/** An argv's words, the shell's `-c` script body (shellBodyIndexes) read as a shell body and every other word as one word. */
function reviewArgv(command: string, args: JsonValue[]): JsonValue {
  const bodies = shellBodyIndexes([command, ...args.map(item => (typeof item === 'string' ? item : ''))])
  return args.map((item, index) => review(item, bodies.has(index + 1) ? 'shell' : 'word'))
}

function readingOf(owner: JsonObject, key: string): Reading {
  if (key === 'command' && Array.isArray(owner.args)) return 'word'
  if (key === 'env') return 'word'
  if (key === 'script' && typeof owner.runtime === 'string') return SHELL_COMMANDS.has(baseCommand(owner.runtime)) ? 'shell' : 'text'
  if ((key === 'content' || key === 'edits') && typeof owner.path === 'string') return isShellScript(owner.path, owner.content) ? 'shell' : 'file'
  return 'shape'
}

/** Script files a shell runs: a shell extension or rc file, or a `#!` line naming a shell. */
const SHELL_SCRIPT_NAME = /(?:\.(?:sh|bash|zsh|ksh|dash|command)|(?:^|\/)\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|kshrc))$/i
const SHEBANG = /^#!\s*(\S+)(?:\s+(\S+))?/

function isShellScript(path: string, content: JsonValue | undefined): boolean {
  if (SHELL_SCRIPT_NAME.test(path)) return true
  const shebang = typeof content === 'string' ? SHEBANG.exec(content) : null
  if (!shebang) return false
  const interpreter = baseCommand(shebang[1]!)
  return SHELL_COMMANDS.has(interpreter === 'env' ? baseCommand(shebang[2] ?? '') : interpreter)
}

const JSON_DOCUMENT = /^\s*[[{]/
const WHITESPACE = /\s/

/** How a string with no context of its own is read: a JSON document, one word, or free text. */
function shapeOf(value: string): CredentialContext {
  if (isJsonDocument(value)) return 'json'
  return WHITESPACE.test(value) ? 'text' : 'word'
}

function isJsonDocument(value: string): boolean {
  return JSON_DOCUMENT.test(value) && parses(value)
}

function parses(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}
