import { shellBodyIndexes } from '../../domain/argv.js'
import { commandForms, readLimitReason, typedForm, type CommandForms } from '../../domain/command-forms.js'
import { PLACES_REASON, type FileReference } from '../../domain/secret-reference.js'
import { ToolInputError } from '../../domain/tool.js'

/** A program and its arguments as the rules read the call: its exec effect. */
export interface ProgramCall {
  command: string
  args: readonly string[]
}

/** An argument of the call that holds references: its index in `args`, and the references in it. */
export interface ArgumentPlace {
  index: number
  references: readonly FileReference[]
}

/**
 * How a shell reads an argument that holds a reference (docs/secrets.md): `argv`, handed to its program as one word that
 * no shell parses again; `shell`, text a shell parses, a `-c` body, script_run's bash body, a command ssh sends, a
 * find -exec command, where a value is held to the characters no shell reads as syntax.
 */
export type ShellTier = 'argv' | 'shell'

/** Why a reference in shell text stands where a shell would split or expand its value. */
export const UNQUOTED_REASON = 'in shell text, write a secret reference inside quotes, such as "Bearer {{file:.env.local:TOKEN}}" or \'{{file:.env.local:TOKEN}}\', so its value stays one word a shell does not split, expand, or glob'
/** Why a reference may not name, or stand in, the program a command runs. */
export const COMMAND_WORD_REASON = 'a secret reference cannot stand in the program a command runs, the folder it is found in, or the name a variable is assigned to; put the reference in an argument or an assigned value'

/** An assignment's name and its `=` (or `+=`): what follows is the value, where a reference may stand. */
const ASSIGNED_NAME = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
/** Why a reference may not follow `$` or a backslash in shell text. */
export const EXPANSION_REASON = 'in shell text, a secret reference cannot follow $ or \\, where its value would be read as part of an expansion or an escape'

const SOH = String.fromCharCode(1)
/** The text a reading of a call stands for each reference in, the same for the same file and NAME, and found in no command. */
const token = (key: string) => `${SOH}${key}${SOH}`
/** The key a reference's value is held under for a call: its file as written and its NAME. */
export const secretKey = (path: string, name: string) => `${path}${SOH}${name}`
const referenceKey = (reference: FileReference) => secretKey(reference.path, reference.name)

/**
 * The references of a shell call, read as the rules read the call, before anyone is asked (docs/secrets.md): the call
 * must be read whole, run no interpreter (whose code Buckle does not read, so a reference there is an interpreter body's),
 * and hold no reference in a command word; a reference in text a shell parses must sit inside quotes, which a probe holding
 * a blank shows (UNQUOTED_REASON), and follow no `$` or backslash. Answers how each place is read, which sets the
 * characters its value may hold. `shellText` marks script_run's bash body, which a shell parses whole.
 */
export function readShellReferences(input: { call: ProgramCall; places: readonly ArgumentPlace[]; shellText: boolean }): Map<number, ShellTier> {
  const { call, places } = input
  const original = commandForms(call.command, call.args)
  if (original.unread !== null || original.overBudget || original.scriptData) {
    const limit = original.unread ?? (original.overBudget ? 'budget' : 'scriptData')
    throw refused(`a secret reference is read only in a command Buckle reads whole, and this one it does not: ${readLimitReason(limit, original)}`)
  }
  if (original.interpreters.length > 0) throw refused(`${PLACES_REASON}; ${original.interpreters.join(', ')} runs code Buckle does not read, so a reference in this call would reach an interpreter's code`)
  const references = places.flatMap(place => place.references)
  const asRead = mapped(original, word => withTokens(word, references))
  for (const form of [...original.chain, ...original.nested, ...original.pieces, ...original.heads]) {
    for (const word of [form[0] ?? '', typedForm(form)[0] ?? '']) {
      // An assignment before a command, or standing alone, may take a reference in its value, never in its name.
      const assigned = ASSIGNED_NAME.exec(word)
      const named = assigned ? assigned[0] : word
      if (named.includes('{{') || named.includes('}}') || named.includes(SOH)) throw refused(COMMAND_WORD_REASON)
    }
  }
  const words = [call.command, ...call.args]
  const bodies = shellBodyIndexes(words)
  const parsed = [...asRead.nested, ...asRead.pieces, ...asRead.heads].flat()
  const tiers = new Map<number, ShellTier>()
  for (const place of places) {
    const tokens = place.references.map(reference => token(referenceKey(reference)))
    const shell = input.shellText || bodies.has(place.index + 1) || parsed.some(word => tokens.some(item => word.includes(item)))
    tiers.set(place.index, shell ? 'shell' : 'argv')
  }
  const shellPlaces = places.filter(place => tiers.get(place.index) === 'shell')
  for (const place of shellPlaces) {
    const text = call.args[place.index]!
    if (place.references.some(reference => reference.start > 0 && (text[reference.start - 1] === '$' || text[reference.start - 1] === '\\'))) throw refused(EXPANSION_REASON)
  }
  if (shellPlaces.length > 0) {
    // A probe holding a blank in each reference's place: where a shell would split it, the reading changes.
    const probes = new Map(references.map((reference, index) => [referenceKey(reference), `bucklesecretprobe${index}a bucklesecretprobe${index}b`]))
    const probed = substituted(call, shellPlaces, reference => probes.get(referenceKey(reference))!)
    const probedForms = commandForms(probed.command, probed.args)
    const byProbe = [...probes].map(([key, probe]) => [probe, token(key)] as const)
    if (JSON.stringify(mapped(probedForms, word => replaceAll(withTokens(word, references), byProbe))) !== JSON.stringify(asRead)) throw refused(UNQUOTED_REASON)
  }
  return tiers
}

/**
 * Whether the call with each reference's value in its place reads as the call with the references did, word for word
 * with each value where its reference stood (docs/secrets.md): a value that splits a word, starts a statement, or
 * opens a substitution changes the reading, and the call does not run.
 */
export function readsAsReferenced(input: { call: ProgramCall; substituted: ProgramCall; references: readonly FileReference[]; values: ReadonlyMap<string, string> }): boolean {
  const before = mapped(commandForms(input.call.command, input.call.args), word => withTokens(word, input.references))
  const byValue = input.references.map(reference => [input.values.get(referenceKey(reference))!, token(referenceKey(reference))] as const)
  byValue.sort((left, right) => right[0].length - left[0].length)
  const after = mapped(commandForms(input.substituted.command, input.substituted.args), word => replaceAll(word, byValue))
  return JSON.stringify(after) === JSON.stringify(before)
}

/** The key a reference's value is held under for a call: its file as written and its NAME. */
export { referenceKey }

/** The call with each reference in the given places replaced by what `value` answers for it. */
export function substituted(call: ProgramCall, places: readonly ArgumentPlace[], value: (reference: FileReference) => string): ProgramCall {
  const args = [...call.args]
  for (const place of places) args[place.index] = replaceReferences(args[place.index]!, place.references, value)
  return { command: call.command, args }
}

/** Text with each of its references, by position, replaced by what `value` answers for it. */
export function replaceReferences(text: string, references: readonly FileReference[], value: (reference: FileReference) => string): string {
  let result = ''
  let at = 0
  for (const reference of [...references].sort((left, right) => left.start - right.start)) {
    result += text.slice(at, reference.start) + value(reference)
    at = reference.end
  }
  return result + text.slice(at)
}

/** A reading with each word passed through `word`, in the shape two readings are compared in. */
function mapped(forms: CommandForms, word: (text: string) => string) {
  const each = (list: readonly string[][]) => list.map(form => form.map(word))
  return { chain: each(forms.chain), nested: each(forms.nested), pieces: each(forms.pieces), heads: each(forms.heads), unread: forms.unread, overBudget: forms.overBudget, scriptData: forms.scriptData, interpreters: forms.interpreters }
}

function withTokens(word: string, references: readonly FileReference[]): string {
  return replaceAll(word, references.map(reference => [reference.raw, token(referenceKey(reference))] as const))
}

function replaceAll(text: string, pairs: ReadonlyArray<readonly [string, string]>): string {
  let result = text
  for (const [from, to] of pairs) if (from !== '' && result.includes(from)) result = result.split(from).join(to)
  return result
}

function refused(message: string): ToolInputError {
  return new ToolInputError(message, { code: 'PERMISSION_DENIED' })
}
