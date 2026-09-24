import { randomBytes } from 'node:crypto'
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * Sets one variable in an environment file's text, in place where it is already there: the line
 * that sets it is replaced, otherwise the commented placeholder `buckle init` wrote is filled in,
 * otherwise it is appended. Keeping the file's shape is what lets a credential be written back
 * beside the ones already in it without an operator's comments or ordering being lost.
 *
 * The replacement goes through a function, so a `$&` in a credential is a literal. A value holding a
 * line break or NUL is refused whoever the caller is: it would end the line and start another, so
 * a value from elsewhere could set any variable it liked.
 */
export function setEnvironmentVariable(input: { text: string; name: string; value: string }): string {
  if (breaksLine(input.value)) throw new Error(`${input.name} holds a line break or NUL, which an environment file cannot hold in one line; nothing was written`)
  const assignment = `${input.name}=${input.value}`
  const set = new RegExp(`^${input.name}=.*$`, 'm')
  if (set.test(input.text)) return input.text.replace(set, () => assignment)

  const placeholder = new RegExp(`^#\\s*${input.name}=.*$`, 'm')
  if (placeholder.test(input.text)) return input.text.replace(placeholder, () => assignment)

  return `${input.text.endsWith('\n') ? input.text : `${input.text}\n`}${assignment}\n`
}

export type EnvironmentEdit = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Sets or removes one variable and proves nothing else moved: the result is parsed back and must
 * hold exactly the variables the original did, with only this one changed. A variable written
 * twice, with `export`, or across several quoted lines is not edited, because a line-level
 * replacement could leave a second reading behind or cut a value in half; the owner edits those
 * by hand. A value the plain form would read differently is written in double quotes.
 */
export function editEnvironmentVariable(input: { text: string; name: string; value: string | null }): EnvironmentEdit {
  if (input.value !== null && breaksLine(input.value)) return { ok: false, reason: `${input.name} cannot hold a line break or NUL` }
  const handEdit = `${input.name} is written in a form this command does not edit; change it by hand`
  const lines = input.text.split('\n')
  const mentions = lines.filter(line => new RegExp(`^\\s*(export\\s+)?${input.name}\\s*=`).test(line))
  if (mentions.length > 1 || mentions.some(line => !line.startsWith(`${input.name}=`))) return { ok: false, reason: handEdit }

  const before = parseEnv(input.text)
  // A quoted value spanning lines reads differently from its first line alone.
  if (mentions[0] !== undefined && parseEnv(mentions[0])[input.name] !== before[input.name]) return { ok: false, reason: handEdit }
  const expected: Record<string, string | undefined> = { ...before }
  if (input.value === null) delete expected[input.name]
  else expected[input.name] = input.value

  const candidates = input.value === null
    ? [lines.filter(line => !line.startsWith(`${input.name}=`)).join('\n')]
    : [input.value, `"${input.value}"`].map(value => setEnvironmentVariable({ text: input.text, name: input.name, value }))
  const text = candidates.find(candidate => sameVariables(parseEnv(candidate), expected))
  return text === undefined ? { ok: false, reason: handEdit } : { ok: true, text }
}

/**
 * Replaces the file in one step: a temporary file beside it takes the new text and the old file's
 * mode bits, then is renamed over it, so a reader never sees half a file and a crash leaves the old one.
 */
export function writeFileAtomically(path: string, text: string): void {
  const mode = statSync(path).mode & 0o7777
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, text, { mode, flag: 'wx' })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function breaksLine(value: string): boolean {
  return /[\n\r\0]/.test(value)
}

function sameVariables(actual: Record<string, string | undefined>, expected: Record<string, string | undefined>): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
  return [...keys].every(key => actual[key] === expected[key])
}
