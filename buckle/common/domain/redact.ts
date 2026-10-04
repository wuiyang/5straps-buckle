import { isNamedCredentialKey, redactCredentials, type CredentialContext } from '@5straps/runtime'
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
 * value under a key named password, secret, or token redacted, every other string hidden only where owner ruling B
 * hides it (redactCredentials: a whole URL's password and credential query values, a named key's value), and nothing
 * else changed: no string, path or list is cut, and no size stands in for the call. Display only: a decision
 * binds the call's whole arguments through its fingerprint, not this.
 *
 * Where a string sits decides how it is read: a `command` with its `args` is an argv, each word one value and a
 * shell's `-c` script shown as written; `env` values are values; a `script` beside its `runtime`, and a shell
 * script's `content` or edit texts beside its `path`, show as written; any other file's content is a JSON
 * document when it parses as an object or array and free text otherwise, so a one-line CSV row shows its fields
 * (slice 7d review R7D-WV-3). Any other string is read by its shape: a JSON document when it parses as an object
 * or array, free text when it holds whitespace, and one value otherwise.
 */
export function reviewableArguments(args: JsonObject): JsonValue {
  return reviewObject(args)
}

/** How a string is read: by a context, as a script shown as written, by its shape, or as a file's content. */
type Reading = CredentialContext | 'script' | 'shape' | 'file'

function review(value: JsonValue, reading: Reading): JsonValue {
  if (typeof value === 'string') return reading === 'script' ? value : reviewString(value, contextOf(value, reading))
  if (Array.isArray(value)) return value.map(item => review(item, reading))
  if (value !== null && typeof value === 'object') return reading === 'shape' ? reviewObject(value) : reviewRecord(value, reading)
  return value
}

/**
 * A string redacted in its context. A JSON document after one byte order mark is read as the JSON its consumers
 * parse, and the mark is shown as written (slice 7e review R7E-FS-1).
 */
function reviewString(value: string, context: CredentialContext): string {
  if (context === 'json' && value.startsWith(BYTE_ORDER_MARK)) return BYTE_ORDER_MARK + redactCredentials(value.slice(BYTE_ORDER_MARK.length), 'json')
  return redactCredentials(value, context)
}

function contextOf(value: string, reading: Exclude<Reading, 'script'>): CredentialContext {
  if (reading === 'shape') return shapeOf(value)
  if (reading === 'file') return isJsonDocument(value) ? 'json' : 'text'
  return reading
}

/**
 * An object's keys in order, a value under a key named password, secret, or token (isNamedCredentialKey) hidden whole.
 * Only those three words hide a key's value here: an `Authorization` header, a `credentials` object, or an env name such
 * as AUTH_HOOK or COOKIE_JAR_PATH shows as its value reads, as the approver needs to see it. The process log's broader
 * matcher (isCredentialKey) stays with the log.
 */
function reviewObject(value: JsonObject): JsonValue {
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const item = value[key] ?? null
    if (isNamedCredentialKey(key, item)) return [key, '[redacted]']
    if (key === 'args' && typeof value.command === 'string' && Array.isArray(item)) return [key, reviewArgv(value.command, item)]
    return [key, review(item, readingOf(value, key))]
  }))
}

/** An object whose values are all read one way (`env`'s values are values, an edit's texts are file content), a key named password, secret, or token still hidden. */
function reviewRecord(value: JsonObject, reading: Exclude<Reading, 'shape'>): JsonValue {
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const item = value[key] ?? null
    return [key, isNamedCredentialKey(key, item) ? '[redacted]' : review(item, reading)]
  }))
}

/** An argv's words, the shell's `-c` script body (shellBodyIndexes) shown as written and every other word read as one value. */
function reviewArgv(command: string, args: JsonValue[]): JsonValue {
  const bodies = shellBodyIndexes([command, ...args.map(item => (typeof item === 'string' ? item : ''))])
  return args.map((item, index) => review(item, bodies.has(index + 1) ? 'script' : 'value'))
}

function readingOf(owner: JsonObject, key: string): Reading {
  if (key === 'command' && Array.isArray(owner.args)) return 'value'
  if (key === 'env') return 'value'
  if (key === 'script' && typeof owner.runtime === 'string') return 'script'
  if ((key === 'content' || key === 'edits') && typeof owner.path === 'string') return isShellScript(owner.path, owner.content) ? 'script' : 'file'
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
/** U+FEFF, which some editors write at the start of a UTF-8 file and many JSON readers skip; JSON.parse refuses it. */
const BYTE_ORDER_MARK = '\uFEFF'

/** How a string with no context of its own is read: a JSON document, free text, or one value. */
function shapeOf(value: string): CredentialContext {
  if (isJsonDocument(value)) return 'json'
  return WHITESPACE.test(value.trim()) ? 'text' : 'value'
}

/** A JSON object or array, after one leading byte order mark when it has one. */
function isJsonDocument(value: string): boolean {
  const document = value.startsWith(BYTE_ORDER_MARK) ? value.slice(BYTE_ORDER_MARK.length) : value
  return JSON_DOCUMENT.test(document) && parses(document)
}

function parses(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}
