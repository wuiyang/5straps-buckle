/**
 * The owner's command patterns: shell-word globs matched against parsed argv one word at a
 * time, never a regular expression that could reinterpret a command line.
 *
 * A pattern is words separated by whitespace. Inside a word, `*` matches any run of characters
 * and `{a,b}` matches one of its alternatives, so `--port=*` and `{build,test}` are single
 * words. A word that is `*` matches exactly one word, except as the pattern's last word, where
 * it matches the rest of the line including nothing. `**` matches any run of words wherever it
 * stands.
 *
 * The two matchers are what make each list err toward refusing. An allow list uses
 * `matchesLine`, so it admits only the shape it spells out and `docker compose up` never
 * carries an unnamed flag in. A deny list uses `matchesPrefix`, so naming a binary stops it
 * whatever arguments follow.
 */

/** Characters that only mean something in a regular expression, and so name a pattern needing migration. */
const REGEX_ONLY_CHARACTERS = ['^', '$', '(', ')', '|', '\\', '+', '?', '[', ']']

const MAX_ALTERNATIVES = 64

export class CommandGlobError extends Error {}

export interface CommandGlob {
  readonly source: string
  /** True when the pattern covers every word of the line. */
  matchesLine(words: string[]): boolean
  /** True when the pattern covers the line's leading words, whatever follows them. */
  matchesPrefix(words: string[]): boolean
}

type WordPattern =
  | { kind: 'any_words' }
  | { kind: 'one_word'; alternatives: string[] }

export function compileCommandGlob(source: string): CommandGlob {
  const trimmed = source.trim()
  if (!trimmed) throw new CommandGlobError('A command pattern cannot be empty')
  rejectRegexSyntax(trimmed)

  const words = trimmed.split(/\s+/)
  const patterns = words.map((word, index) => toWordPattern(word, index === words.length - 1))

  return {
    source: trimmed,
    matchesLine: line => matchFrom({ patterns, line, allowTrailing: false }, 0, 0),
    matchesPrefix: line => matchFrom({ patterns, line, allowTrailing: true }, 0, 0),
  }
}

/** True for a pattern this module can compile, used to tell a glob from a regular expression. */
export function isCommandGlob(source: string): boolean {
  try {
    compileCommandGlob(source)
    return true
  } catch {
    return false
  }
}

function rejectRegexSyntax(source: string): void {
  const found = REGEX_ONLY_CHARACTERS.filter(character => source.includes(character))
  if (found.length === 0) return
  throw new CommandGlobError(
    `${found.join(' ')} ${found.length === 1 ? 'is' : 'are'} regular-expression syntax, and a command pattern is a shell-word glob like 'pnpm {build,test} *'. Run 'buckle policy migrate' to convert the stored patterns.`,
  )
}

function toWordPattern(word: string, isLast: boolean): WordPattern {
  if (word === '**' || (isLast && word === '*')) return { kind: 'any_words' }
  return { kind: 'one_word', alternatives: expandBraces(word) }
}

/** `pnpm-{lock,workspace}.yaml` becomes the two wildcard patterns a single word may take. */
function expandBraces(word: string): string[] {
  let alternatives = ['']
  let index = 0

  while (index < word.length) {
    const character = word.charAt(index)
    if (character === '}') throw new CommandGlobError(`An unmatched } in ${JSON.stringify(word)}`)
    if (character !== '{') {
      alternatives = alternatives.map(alternative => alternative + character)
      index += 1
      continue
    }

    const close = word.indexOf('}', index)
    if (close === -1) throw new CommandGlobError(`An unclosed { in ${JSON.stringify(word)}`)
    const body = word.slice(index + 1, close)
    if (body.includes('{')) throw new CommandGlobError(`Nested { } in ${JSON.stringify(word)}`)
    const choices = body.split(',')
    if (choices.some(choice => choice === '')) throw new CommandGlobError(`An empty alternative in ${JSON.stringify(word)}`)

    alternatives = alternatives.flatMap(prefix => choices.map(choice => prefix + choice))
    if (alternatives.length > MAX_ALTERNATIVES) throw new CommandGlobError(`Over ${MAX_ALTERNATIVES} alternatives in ${JSON.stringify(word)}`)
    index = close + 1
  }

  return alternatives
}

interface MatchState {
  patterns: WordPattern[]
  line: string[]
  /** Whether words past the pattern are allowed, which is what makes a deny rule cover arguments. */
  allowTrailing: boolean
}

function matchFrom(state: MatchState, patternIndex: number, wordIndex: number): boolean {
  const pattern = state.patterns[patternIndex]
  if (!pattern) return state.allowTrailing || wordIndex === state.line.length

  if (pattern.kind === 'any_words') {
    for (let next = wordIndex; next <= state.line.length; next += 1) {
      if (matchFrom(state, patternIndex + 1, next)) return true
    }
    return false
  }

  const word = state.line[wordIndex]
  if (word === undefined) return false
  if (!pattern.alternatives.some(alternative => matchesWildcard(alternative, word))) return false
  return matchFrom(state, patternIndex + 1, wordIndex + 1)
}

/** One word against one alternative, where `*` stands for any run of characters. */
function matchesWildcard(pattern: string, word: string): boolean {
  let patternIndex = 0
  let wordIndex = 0
  let star = -1
  let starWord = 0

  while (wordIndex < word.length) {
    if (patternIndex < pattern.length && pattern.charAt(patternIndex) === '*') {
      star = patternIndex
      starWord = wordIndex
      patternIndex += 1
    } else if (patternIndex < pattern.length && pattern.charAt(patternIndex) === word.charAt(wordIndex)) {
      patternIndex += 1
      wordIndex += 1
    } else if (star === -1) {
      return false
    } else {
      patternIndex = star + 1
      wordIndex = starWord + 1
      starWord += 1
    }
  }

  while (pattern.charAt(patternIndex) === '*') patternIndex += 1
  return patternIndex === pattern.length
}
