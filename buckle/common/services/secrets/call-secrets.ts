import { createHash } from 'node:crypto'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { ExecEffect, ResolvedEffect } from '../../domain/effect.js'
import type { PermissionEngine, PermissionOutcome } from '../../domain/permission/engine.js'
import { MIN_SECRET_LENGTH, SHORT_REASON, type FileReference } from '../../domain/secret-reference.js'
import { ToolInputError, type FilledSecret, type FilledSecrets, type HeldSecret, type PreparedCall, type ToolContext } from '../../domain/tool.js'
import { createMasker, holdMasker, type SecretValue } from './mask.js'
import type { SecretPlace, SecretPlan } from './places.js'
import { readSecretValues } from './secret-file.js'
import type { ScriptSecrets } from './script-secrets.js'
import { positionalIndexes } from '../packs/browser/effects.js'
import { readShellReferences, readsAsReferenced, referenceKey, replaceReferences, secretKey, substituted, type ArgumentPlace, type ProgramCall, type ShellTier } from './shell-reading.js'

/**
 * A call's references as the gate checked them (docs/secrets.md): the plan, each file's real path as the rules judged
 * it, and for a shell call how each argument holding one is read, which the run checks the values against.
 */
export interface CheckedSecrets {
  plan: SecretPlan
  files: ReadonlyMap<string, string>
  shell: ShellCall | null
}

interface ShellCall {
  call: ProgramCall
  places: ArgumentPlace[]
  tiers: ReadonlyMap<number, ShellTier>
}

export type { FilledSecrets }

/**
 * The gate's check of a call's references (docs/secrets.md), before anyone is asked: for shell_exec and script_run's
 * bash body, how Buckle reads each argument that holds one (readShellReferences), refusing a reference the rules could
 * not read as written. Browser fill text and web_fetch headers reach no shell.
 */
export function checkSecrets(input: { tool: string; args: JsonObject; plan: SecretPlan; effects: readonly ResolvedEffect[] }): CheckedSecrets {
  const files = new Map(input.effects.flatMap(effect => (effect.kind === 'secret_file' ? effect.written.map(written => [written, effect.path] as const) : [])))
  const exec = input.effects.find((effect): effect is ExecEffect => effect.kind === 'exec')
  const shellPlaces = input.plan.places.filter(place => place.kind === 'argv' || place.kind === 'shell')
  if (shellPlaces.length === 0 || exec === undefined) return { plan: input.plan, files, shell: null }
  const shellText = input.tool === 'script_run'
  // script_run's body is the `-c` string of its exec effect; shell_exec's argument i is the effect's argument i.
  const places = shellPlaces.map((place) => {
    const index = shellText ? exec.args.indexOf(place.text) : place.at[1] as number
    if (index < 0 || exec.args[index] !== place.text) throw refused('A secret reference stands where Buckle cannot place it in the command it judges')
    return { index, references: place.references }
  })
  const call = { command: exec.command, args: exec.args }
  return { plan: input.plan, files, shell: { call, places, tiers: readShellReferences({ call, places, shellText }) } }
}

/**
 * Runs a call with each reference's value in its place, read just before the tool starts (docs/secrets.md): every file
 * is read where it was judged, each value checked for where it goes (MIN_SECRET_LENGTH, and what its place may hold), the
 * arguments rebuilt with the values in them and the tool prepared from them, and a shell call read again to be sure it
 * reads as it did with the references, by the command reader and by the rules. Everything the tool answers, and every
 * error it throws, is masked; a browser call is also masked by every value its workspace's browsers were filled with.
 * The values are held only while the tool runs, then dropped; a code_run script's call hands them to its script first,
 * which masks every later call it makes by them (ScriptSecrets).
 */
export async function runWithSecrets(input: {
  checked: CheckedSecrets | null
  filled?: FilledSecrets
  /** For a call a code_run script made: the script's values, which this call's are added to before its tool runs. */
  script?: ScriptSecrets
  tool: string
  args: JsonObject
  prepare: (args: JsonObject) => PreparedCall
  execute: (context: ToolContext) => Promise<JsonValue>
  permissions: PermissionEngine
  context: ToolContext
  protectedRoots: readonly string[]
  roots: readonly string[]
}): Promise<JsonValue> {
  const { checked } = input
  const read = checked ? readCallValues(checked, input) : new Map<string, SecretValue>()
  const values = new Map([...read].map(([key, secret]) => [key, secret.value]))
  // A browser call is masked by every value its workspace's browsers hold: those filled before it starts, held while it
  // runs, and, read again once it answers, those a call beside it filled meanwhile.
  const browser = input.tool === 'browser_command' && input.filled ? input.filled : null
  // Close shows no page, so it runs though a value the browser holds no longer reads, and ends the hold that refused
  // every other call; it is masked by every value that still reads.
  const closing = browser !== null && input.args.command === 'close'
  const held = async () => browser ? readFilledValues(await browser.list({ context: input.context, args: input.args }), input, closing) : []
  const masker = createMasker([...read.values(), ...await held()])
  const release = holdMasker(masker)
  const answered = async (output: JsonValue): Promise<JsonValue> => {
    const masked = masker.json(output)
    if (!browser) return masked
    const late = createMasker(await held())
    try { return late.json(masked) } finally { late.drop() }
  }
  try {
    if (!checked) return await answered(await input.execute(input.context))
    for (const place of checked.plan.places) for (const reference of place.references) checkValue(place, reference, values.get(referenceKey(reference))!, checked.shell?.tiers)
    const args = substitutedArguments(input.args, checked.plan.places, reference => values.get(referenceKey(reference))!)
    const prepared = input.prepare(args)
    if (checked.shell) assertSameReading({ shell: checked.shell, prepared, values, permissions: input.permissions, tool: input.tool })
    const fillPlaces = checked.plan.places.filter(place => place.kind === 'fill')
    if (fillPlaces.length > 0) assertSamePositionals(input.args, args)
    // The browser pack records each value it is handed with the session that runs it, before the browser runs.
    const fills: FilledSecret[] = fillPlaces.flatMap(place => place.references).map(reference => ({ real: checked.files.get(reference.path)!, written: reference.path, name: reference.name, digest: digestOf(values.get(referenceKey(reference))!) }))
    const headers = checked.plan.places.filter(place => place.kind === 'header').map(place => String(place.at[1]))
    input.script?.add([...checked.plan.files].flatMap(([written, names]) => names.map(name => ({ real: checked.files.get(written)!, written, name, value: values.get(secretKey(written, name))! }))))
    return await answered(await prepared.execute({ ...input.context, ...headers.length > 0 ? { secretHeaders: headers } : {}, ...fills.length > 0 ? { secretFills: fills } : {} }))
  } catch (error) {
    const masked = maskError(error, masker.text)
    if (!browser) throw masked
    const late = createMasker(await held())
    try { throw maskError(masked, late.text) } finally { late.drop() }
  } finally {
    release()
    masker.drop()
    values.clear()
    read.clear()
  }
}

/** Each value the call's references name, by secretKey, each file read once where it was judged. */
function readCallValues(checked: CheckedSecrets, input: { protectedRoots: readonly string[]; roots: readonly string[] }): Map<string, SecretValue> {
  const values = new Map<string, SecretValue>()
  for (const [written, names] of checked.plan.files) {
    const real = checked.files.get(written)
    if (real === undefined) throw refused(`The secret file ${written} was not judged before the call ran`)
    const read = readSecretValues({ real, written, names, protectedRoots: input.protectedRoots, roots: input.roots })
    for (const [name, value] of read) values.set(secretKey(written, name), { name, value })
    read.clear()
  }
  return values
}

/**
 * The values a workspace's browsers were filled with, read again now; one that cannot be read, or reads as another value
 * than the one filled, refuses the call, as its result could not be masked, except a close (`skipStale`), which shows no
 * page and is masked by the rest.
 */
function readFilledValues(filled: readonly HeldSecret[], input: { protectedRoots: readonly string[]; roots: readonly string[] }, skipStale: boolean): SecretValue[] {
  const byFile = new Map<string, { written: string; names: string[] }>()
  for (const entry of filled) {
    const file = byFile.get(entry.real) ?? { written: entry.written, names: [] }
    file.names.push(entry.name)
    byFile.set(entry.real, file)
  }
  const ends = (test: (entry: HeldSecret) => boolean) => heldHint(filled.filter(test))
  const digests = new Map(filled.map(entry => [`${entry.real}\u0000${entry.name}`, entry.digest]))
  const values: SecretValue[] = []
  for (const [real, file] of byFile) {
    let read: Map<string, string>
    try { read = readSecretValues({ real, written: file.written, names: file.names, protectedRoots: input.protectedRoots, roots: input.roots }) } catch (error) {
      if (skipStale) continue
      throw refused(`A secret value this browser was filled with can no longer be read, so this browser call's result could not be masked: ${(error as Error).message}.${ends(entry => entry.real === real)}`)
    }
    for (const [name, value] of read) {
      if (digests.get(`${real}\u0000${name}`) === digestOf(value)) values.push({ name, value })
      else if (!skipStale) throw refused(`The secret ${name} in ${file.written} changed since this browser was filled with it, so this browser call's result could not be masked.${ends(entry => entry.real === real && entry.name === name)}`)
    }
    read.clear()
  }
  return values
}

/**
 * What ends a hold that refused a call (Slice F4, item 7): every browser of the workspace that holds the value, by whom it
 * serves and when it was last used, with the agent's close that ends it, and the owner's command that ends them all.
 */
function heldHint(entries: readonly HeldSecret[]): string {
  const holders = [...new Set(entries.flatMap(entry => entry.holders ?? []))]
  const command = entries.find(entry => entry.ownerCommand !== undefined)?.ownerCommand ?? 'buckle browser close'
  const held = holders.length === 0 ? '' : ` It is held by ${holders.length} ${holders.length === 1 ? 'browser' : 'browsers'}: ${holders.join('; ')}.`
  return `${held} Put the file back, or end ${holders.length === 1 ? 'it' : 'them'}; the owner's ${command} ends every browser of the workspace and drops what they hold`
}

export function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Refuses browser text whose value would move which argument agent-browser takes as the text, as a flag's value would. */
function assertSamePositionals(before: JsonObject, after: JsonObject): void {
  const positionals = (args: JsonObject) => JSON.stringify(positionalIndexes(Array.isArray(args.args) ? args.args as string[] : []))
  if (positionals(before) !== positionals(after)) throw refused('A secret value would change which argument the browser takes as its text, so the call did not run')
}

/** Characters a value placed in shell text may not hold: a quote, an escape, an expansion, a history mark, or a control character. */
const SHELL_UNSAFE = /["'`\\$!\u0000-\u001f\u007f]/
/** Characters no value may hold: NUL, which no argument can, and the mark the command reader's comparison stands on. */
const NEVER = /[\u0000\u0001]/

/**
 * Whether a value may stand where its reference does (docs/secrets.md), refused naming the reference, never the value: at
 * least MIN_SECRET_LENGTH characters (SHORT_REASON); in shell text, none a shell reads as syntax inside quotes, and no
 * leading `-`; as a whole argument or browser text, no leading `-`, which its program would read as an option; in a
 * header, no line break.
 */
function checkValue(place: SecretPlace, reference: FileReference, value: string, tiers: ReadonlyMap<number, ShellTier> | undefined): void {
  const shown = reference.raw
  if (value.length < MIN_SECRET_LENGTH) throw refused(`${SHORT_REASON}: ${shown} holds fewer than ${MIN_SECRET_LENGTH} characters, so its value could not be told from other text`)
  if (NEVER.test(value)) throw refused(`The value of ${shown} holds a NUL or control character no argument can carry`)
  const tier = place.kind === 'shell' ? 'shell' : place.kind === 'argv' ? tiers?.get(place.at[1] as number) ?? 'shell' : null
  if (tier === 'shell' && (SHELL_UNSAFE.test(value) || value.startsWith('-'))) throw refused(`The value of ${shown} holds a character a shell reads as syntax (a quote, a backslash, $, \`, !, or a control character) or starts with -, and its reference stands in shell text; use it as a whole argument of a program instead`)
  if ((tier === 'argv' && reference.start === 0 || place.kind === 'fill') && value.startsWith('-')) throw refused(`The value of ${shown} starts with -, which its program would read as an option`)
  if (place.kind === 'header' && /[\r\n]/.test(value)) throw refused(`The value of ${shown} holds a line break, which no header value may`)
}

/** A copy of the arguments with each place's references replaced by their values. */
function substitutedArguments(args: JsonObject, places: readonly SecretPlace[], value: (reference: FileReference) => string): JsonObject {
  const copy = structuredClone(args) as JsonObject
  for (const place of places) {
    let holder: JsonValue = copy
    for (const part of place.at.slice(0, -1)) holder = (holder as Record<string | number, JsonValue>)[part]!
    ;(holder as Record<string | number, JsonValue>)[place.at.at(-1)!] = replaceReferences(place.text, place.references, value)
  }
  return copy
}

/**
 * Refuses a shell call whose values change how it reads (docs/secrets.md): the command reader must read it word for word
 * as it read the references, each value where its reference stood, and the rules, judged with no grant, must ask and
 * refuse about it as they did, so no value moves what a rule matched.
 */
function assertSameReading(input: { shell: ShellCall; prepared: PreparedCall; values: ReadonlyMap<string, string>; permissions: PermissionEngine; tool: string }): void {
  const { shell } = input
  const exec = input.prepared.effects.find((effect): effect is ExecEffect => effect.kind === 'exec')
  const references = shell.places.flatMap(place => place.references)
  const changed = () => refused(`The values of ${[...new Set(references.map(reference => reference.raw))].join(', ')} change how Buckle reads the command, so it did not run`)
  if (!exec) throw changed()
  const rebuilt = substituted(shell.call, shell.places, reference => input.values.get(referenceKey(reference))!)
  if (exec.command !== rebuilt.command || exec.args.length !== rebuilt.args.length || exec.args.some((word, index) => word !== rebuilt.args[index])) throw changed()
  if (!readsAsReferenced({ call: shell.call, substituted: rebuilt, references, values: input.values })) throw changed()
  const judged = (effect: ExecEffect) => outcomeShape(input.permissions.evaluate({ tool: input.tool, effects: [effect], grants: { subjectsFor: () => [] } }))
  if (judged({ kind: 'exec', command: shell.call.command, args: [...shell.call.args] }) !== judged(exec)) throw changed()
}

/** What of an outcome a value may not move: allow, ask, or deny, and the rule and cause of each ask or the denial. */
function outcomeShape(outcome: PermissionOutcome): string {
  if (outcome.kind === 'deny') return `deny ${outcome.denial.rule}`
  if (outcome.kind === 'ask') return `ask ${outcome.asks.map(ask => `${ask.rule}/${ask.cause ?? ''}`).sort().join(' ')}`
  return 'allow'
}

/** An error the tool threw, its message, stack, and causes masked in place, so its class and fields stay. */
function maskError(error: unknown, mask: (text: string) => string): unknown {
  if (typeof error === 'string') return mask(error)
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    current.message = mask(current.message)
    if (current.stack !== undefined) current.stack = mask(current.stack)
    current = current.cause
  }
  return error
}

function refused(message: string): ToolInputError {
  return new ToolInputError(message, { code: 'PERMISSION_DENIED' })
}

