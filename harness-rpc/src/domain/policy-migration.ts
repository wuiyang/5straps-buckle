import { isCommandGlob } from './command-glob.js'

/**
 * The one-way conversion from the regular expressions command patterns used to be into the
 * shell-word globs they are now. It runs from `buckle policy migrate` and writes nothing by
 * itself: a pattern reinterpreted as a looser glob would open a hole the owner never approved,
 * so anything this cannot read comes back for a person to write.
 */
export interface PatternMigration {
  source: string
  /** The suggested glob, or null when the pattern needs a person. */
  glob: string | null
  /** Why it could not convert, or how the meaning moved. */
  note: string | null
}

export class PatternMigrationError extends Error {}

/** Characters a glob word carries as themselves. */
const LITERAL_CHARACTER = /[A-Za-z0-9_.,/:@=~-]/

/** Backslash escapes whose only meaning is the character itself. */
const ESCAPED_LITERALS = new Set(['.', '/', '-', '+', '?', '*', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', ' ', ','])

export function migrateCommandPattern(source: string): PatternMigration {
  const trimmed = source.trim()
  if (isCommandGlob(trimmed)) return { source: trimmed, glob: trimmed, note: 'already a glob' }

  try {
    return convert(trimmed)
  } catch (error) {
    if (error instanceof PatternMigrationError) return { source: trimmed, glob: null, note: error.message }
    throw error
  }
}

function convert(source: string): PatternMigration {
  const anchoredStart = source.startsWith('^')
  const body = source.slice(anchoredStart ? 1 : 0)
  const anchoredEnd = body.endsWith('$') && !body.endsWith('\\$')

  const builder = createBuilder()
  scan({ text: anchoredEnd ? body.slice(0, -1) : body, builder, insideGroup: false })
  flushWord(builder)

  const words = builder.words
  if (words.length === 0) throw new PatternMigrationError('nothing is left once the anchors are dropped')
  // An unanchored end matched a prefix of the line, which a trailing `*` is.
  if (!anchoredEnd && words.at(-1) !== '*') words.push('*')

  const glob = words.join(' ')
  if (!isCommandGlob(glob)) throw new PatternMigrationError(`the conversion produced ${JSON.stringify(glob)}, which is not a glob`)
  return {
    source,
    glob,
    note: anchoredStart ? null : 'it was not anchored, and a glob always matches from the first word',
  }
}

interface Builder {
  words: string[]
  /** The word being read, as the alternatives it may take. */
  alternatives: string[]
  /** Whether one character was appended last, which is the only thing `?` can make optional. */
  optionalTarget: boolean
}

function createBuilder(): Builder {
  return { words: [], alternatives: [''], optionalTarget: false }
}

function scan(input: { text: string; builder: Builder; insideGroup: boolean }): void {
  const { text, builder, insideGroup } = input
  let index = 0

  while (index < text.length) {
    const character = text.charAt(index)

    if (character === ' ' || character === '\t') {
      if (insideGroup) throw new PatternMigrationError('a space inside a group is more than a glob word can hold')
      flushWord(builder)
      index += 1
      continue
    }

    if (character === '\\') {
      index += consumeEscape({ text, index, builder, insideGroup })
      continue
    }

    if (character === '.' && (text.charAt(index + 1) === '*' || text.charAt(index + 1) === '+')) {
      appendText(builder, '*')
      builder.optionalTarget = false
      index += 2
      continue
    }

    if (character === '(') {
      index = consumeGroup({ text, index, builder, insideGroup })
      continue
    }

    if (character === '?') {
      makeOptional(builder)
      index += 1
      continue
    }

    if (!LITERAL_CHARACTER.test(character)) throw new PatternMigrationError(`${JSON.stringify(character)} has no glob equivalent`)
    appendText(builder, character)
    index += 1
  }
}

/** Returns how many characters the escape took. */
function consumeEscape(input: { text: string; index: number; builder: Builder; insideGroup: boolean }): number {
  const next = input.text.charAt(input.index + 1)
  if (next === 'b') return 2

  if (next === 's') {
    if (input.insideGroup) throw new PatternMigrationError('a space inside a group is more than a glob word can hold')
    flushWord(input.builder)
    const quantifier = input.text.charAt(input.index + 2)
    return quantifier === '+' || quantifier === '*' ? 3 : 2
  }

  if (!ESCAPED_LITERALS.has(next)) throw new PatternMigrationError(`\\${next} has no glob equivalent`)
  appendText(input.builder, next)
  return 2
}

/** Returns the index just past the group. */
function consumeGroup(input: { text: string; index: number; builder: Builder; insideGroup: boolean }): number {
  if (input.insideGroup) throw new PatternMigrationError('a nested group is more than braces can hold')
  const close = input.text.indexOf(')', input.index)
  if (close === -1) throw new PatternMigrationError('an unclosed (')

  const inner = input.text.slice(input.index + 1, close)
  const body = inner.startsWith('?:') ? inner.slice(2) : inner
  if (body.startsWith('?')) throw new PatternMigrationError('a lookaround or a named group has no glob equivalent')

  appendChoices(input.builder, body.split('|').flatMap(alternativesOf))
  return close + 1
}

function alternativesOf(choice: string): string[] {
  const builder = createBuilder()
  scan({ text: choice, builder, insideGroup: true })
  return builder.alternatives
}

function appendText(builder: Builder, text: string): void {
  builder.alternatives = builder.alternatives.map(alternative => alternative + text)
  builder.optionalTarget = text.length === 1
}

function appendChoices(builder: Builder, choices: string[]): void {
  builder.alternatives = builder.alternatives.flatMap(prefix => choices.map(choice => prefix + choice))
  builder.optionalTarget = false
}

/** `python3?` is `python` or `python3`, which braces can say and a glob word cannot. */
function makeOptional(builder: Builder): void {
  if (!builder.optionalTarget) throw new PatternMigrationError('? follows more than a single character, so the alternatives cannot be spelled out')
  builder.alternatives = unique([...builder.alternatives, ...builder.alternatives.map(alternative => alternative.slice(0, -1))])
  builder.optionalTarget = false
}

function flushWord(builder: Builder): void {
  const alternatives = unique(builder.alternatives.filter(Boolean))
  if (alternatives.length === 1) builder.words.push(alternatives[0] ?? '')
  else if (alternatives.length > 1) builder.words.push(`{${alternatives.join(',')}}`)
  builder.alternatives = ['']
  builder.optionalTarget = false
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
