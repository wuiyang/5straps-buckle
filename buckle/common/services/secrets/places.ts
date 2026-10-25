import type { JsonObject, JsonValue } from '@5straps/protocol'
import { ToolInputError } from '../../domain/tool.js'
import { mentionsReference, PLACES_REASON, readReferences, type FileReference } from '../../domain/secret-reference.js'
import { positionalIndexes } from '../packs/browser/effects.js'

/**
 * Where a reference is read (docs/secrets.md): a word of a program's argument list (`argv`), shell text a shell parses
 * (`shell`, script_run's bash body), the text a browser fill or type enters (`fill`), and a web_fetch header's value
 * (`header`).
 */
export type PlaceKind = 'argv' | 'shell' | 'fill' | 'header'

/** One string of a call's arguments that references are read in, with the references it holds. */
export interface SecretPlace {
  /** Where the string is in the call's arguments: keys and indexes from the top. */
  at: ReadonlyArray<string | number>
  kind: PlaceKind
  text: string
  references: FileReference[]
}

/** What a call's references ask for: the places they stand in, and each file they name with the NAMEs read from it. */
export interface SecretPlan {
  places: SecretPlace[]
  /** By the path as written, in the order first met. */
  files: Map<string, string[]>
}

/** A workspace's secret reference settings (secrets in workspace.json): whether references are read at all. */
export interface SecretSettings {
  enabled: boolean
}

/** A call's plan, or none where it holds no reference, or why it is refused. */
export type PlanOutcome = { plan: SecretPlan | null } | { refusal: string }

/** Why a reference is refused in a workspace whose owner turned references off. */
export const SECRETS_OFF_REASON = 'secret references are off in this workspace (secrets.enabled); the owner turns them on with buckle workspace set secrets.enabled on'

/** How many references one call may make, and how many files they may name: enough for any command, and bounded. */
export const MAX_REFERENCES = 64
export const MAX_SECRET_FILES = 16

/** The browser commands whose second positional is the text entered into the page: `fill <selector> <text>`, `type <selector> <text>`. */
const BROWSER_TEXT_COMMANDS = new Set(['fill', 'type'])

/**
 * A call's references, read where the three places are and refused anywhere else (PLACES_REASON), keys included. A
 * reference outside the grammar refuses the call where references are read (readReferences); outside them only text
 * written as a file or env reference does (mentionsReference). With references off, a reference where they are read is
 * refused and other text is not read.
 */
export function planSecrets(input: { tool: string; pack: string; args: JsonObject; enabled: boolean }): PlanOutcome {
  const places: SecretPlace[] = []
  const kindAt = placeKinds(input)
  let refusal: string | null = null
  walk(input.args, [], (text, at, key) => {
    if (refusal !== null || !text.includes('{{')) return
    const kind = key ? null : kindAt(at)
    if (kind === null) {
      if (input.enabled && mentionsReference(text)) refusal = `${PLACES_REASON}; this one is in ${key ? `a key of ${describeAt(at.slice(0, -1))}` : describeAt(at)}`
      return
    }
    const read = readReferences(text)
    if ('refusal' in read) {
      refusal = read.refusal
      return
    }
    if (read.references.length === 0) return
    if (!input.enabled) {
      refusal = SECRETS_OFF_REASON
      return
    }
    places.push({ at, kind, text, references: read.references })
  })
  if (refusal !== null) return { refusal }
  if (places.length === 0) return { plan: null }
  const references = places.flatMap(place => place.references)
  if (references.length > MAX_REFERENCES) return { refusal: `A call makes at most ${MAX_REFERENCES} secret references; this one makes ${references.length}` }
  const files = new Map<string, string[]>()
  for (const reference of references) {
    const names = files.get(reference.path) ?? []
    if (!names.includes(reference.name)) names.push(reference.name)
    files.set(reference.path, names)
  }
  if (files.size > MAX_SECRET_FILES) return { refusal: `A call's secret references name at most ${MAX_SECRET_FILES} files; this one names ${files.size}` }
  return { plan: { places, files } }
}

/** Where each tool of a built-in pack reads references in its arguments, never a plugin's tool: null for anywhere else. */
function placeKinds(input: { tool: string; pack: string; args: JsonObject }): (at: ReadonlyArray<string | number>) => PlaceKind | null {
  const { tool, pack, args } = input
  if (pack === 'shell' && tool === 'shell_exec') return at => (at.length === 2 && at[0] === 'args' && typeof at[1] === 'number' ? 'argv' : null)
  if (pack === 'shell' && tool === 'script_run') return at => (args.runtime === 'bash' && at.length === 1 && at[0] === 'script' ? 'shell' : null)
  if (pack === 'browser' && tool === 'browser_command') {
    const words = Array.isArray(args.args) && args.args.every(word => typeof word === 'string') ? args.args as string[] : null
    const text = typeof args.command === 'string' && BROWSER_TEXT_COMMANDS.has(args.command) && words ? positionalIndexes(words)[1] : undefined
    return at => (text !== undefined && at.length === 2 && at[0] === 'args' && at[1] === text ? 'fill' : null)
  }
  if (pack === 'web' && tool === 'web_fetch') return at => (at.length === 2 && at[0] === 'headers' && typeof at[1] === 'string' ? 'header' : null)
  return () => null
}

/** Every string of a JSON value, keys included (`key` true, `at` ending with the key), with where it stands. */
function walk(value: JsonValue, at: Array<string | number>, visit: (text: string, at: ReadonlyArray<string | number>, key: boolean) => void): void {
  if (typeof value === 'string') return visit(value, at, false)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...at, index], visit))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    visit(key, [...at, key], true)
    walk(item, [...at, key], visit)
  }
}

/** A place in a call's arguments as a reason names it: `args[2]`, `headers.Authorization`, `env.TOKEN`. */
function describeAt(at: ReadonlyArray<string | number>): string {
  if (at.length === 0) return 'the arguments'
  return at.map((part, index) => (typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`)).join('')
}

/** A call's plan as the invoker takes it: none, or the plan; a refusal is thrown as one the caller may not retry differently. */
export function secretPlanOf(input: { tool: string; pack: string; args: JsonObject; enabled: boolean }): SecretPlan | null {
  const outcome = planSecrets(input)
  if ('refusal' in outcome) throw new ToolInputError(outcome.refusal, { code: 'PERMISSION_DENIED' })
  return outcome.plan
}
