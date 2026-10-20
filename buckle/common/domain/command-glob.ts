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

import { writtenAsPath } from './argv.js'

/** Characters that only mean something in a regular expression; a glob never uses them. */
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

/**
 * A glob split by the alternatives of its command word (D74, bare words only): `bare`, the glob as its alternatives with
 * no separator spell it, which meets a command by its bare word; `path`, the glob as its alternatives that spell a path
 * (`/usr/bin/git`, or a wildcard then `/git`), which alone meets a command word written as a path. Either is null where
 * no alternative is of its kind; a first word of `**`, or a lone `*`, is bare. `{git,/usr/bin/git} status` is both, so
 * its bare alternative never admits `./x/git status` as a spelled path would.
 */
export interface CommandWordSplit { bare: CommandGlob | null; path: CommandGlob | null }

const splits = new WeakMap<CommandGlob, CommandWordSplit>()

export function splitByCommandWord(glob: CommandGlob): CommandWordSplit {
  const known = splits.get(glob)
  if (known) return known
  const [first, ...rest] = patternsOf(glob.source)
  const part = (alternatives: string[]) => (alternatives.length === 0 ? null : globOf(glob.source, [{ kind: 'one_word', alternatives }, ...rest]))
  const split = first === undefined || first.kind === 'any_words'
    ? { bare: glob, path: null }
    : { bare: part(first.alternatives.filter(alternative => !writtenAsPath(alternative))), path: part(first.alternatives.filter(writtenAsPath)) }
  splits.set(glob, split)
  return split
}

/**
 * Whether a glob's path half meets a call as typed (D74): only where the call's command word is written plainly
 * (writtenPlainly). `*` crosses `/`, so `/usr/bin/* *` would otherwise meet `/usr/bin/../../elsewhere/git status`, a
 * program outside the folder the rule names. The word is read as asSpelled reads it. The one check the allow list and
 * the floor's exemption share.
 */
export function meetsAsSpelled(path: CommandGlob | null, typed: string[], platform: NodeJS.Platform = process.platform): boolean {
  if (path === null) return false
  const spelled = asSpelled(typed, platform)
  return writtenPlainly(spelled[0] ?? '') && path.matchesLine(spelled)
}

/**
 * A call as typed, as a glob that spells a path reads it: on Windows, where `\` is a separator and a pattern cannot hold
 * one, the command word's `\` read as `/`, so `C:/Tools/git status` spells `C:\Tools\git status`. Elsewhere
 * `\` is part of a name, and `/x/git` names another program than `\x\git`, so the call is left as it is.
 */
export function asSpelled(typed: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const [word, ...rest] = typed
  return platform === 'win32' && word !== undefined ? [word.replaceAll('\\', '/'), ...rest] : [...typed]
}

/**
 * Whether a command word names one program as written: no `.` or `..` segment after a leading `./`, and no empty one,
 * as its lexical normalisation writes it, and no first segment starting with `~`. A shell reads `~/bin/git` from a home
 * folder, while a word Buckle or a wrapper spawns is read under its working folder, where the agent can make a folder
 * named `~`, so such a word names no one program (git pack recheck 1, held[2]).
 */
function writtenPlainly(word: string): boolean {
  const [first, ...rest] = word.split('/')
  if (first?.startsWith('~')) return false
  // An absolute path's empty first segment, and a leading `./`, are how the word starts, not a step in it.
  const steps = first === '' || first === '.' ? rest : [first ?? '', ...rest]
  return steps.every(step => step !== '' && step !== '.' && step !== '..')
}

export function compileCommandGlob(source: string): CommandGlob {
  const trimmed = source.trim()
  if (!trimmed) throw new CommandGlobError('A command pattern cannot be empty')
  rejectRegexSyntax(trimmed)
  return globOf(trimmed, patternsOf(trimmed))
}

function patternsOf(source: string): WordPattern[] {
  const words = source.split(/\s+/)
  return words.map((word, index) => toWordPattern(word, index === words.length - 1))
}

function globOf(source: string, patterns: WordPattern[]): CommandGlob {
  return {
    source,
    matchesLine: line => matchFrom({ patterns, line, allowTrailing: false }, 0, 0),
    matchesPrefix: line => matchFrom({ patterns, line, allowTrailing: true }, 0, 0),
  }
}

function rejectRegexSyntax(source: string): void {
  const found = REGEX_ONLY_CHARACTERS.filter(character => source.includes(character))
  if (found.length === 0) return
  throw new CommandGlobError(
    `${found.join(' ')} ${found.length === 1 ? 'is' : 'are'} regular-expression syntax, and a command pattern is a shell-word glob like 'pnpm {build,test} *'.`,
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
