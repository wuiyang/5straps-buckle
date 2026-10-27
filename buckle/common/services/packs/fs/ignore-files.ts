/**
 * One line of an ignore file, read as git reads .gitignore: `!` re-includes, a trailing `/` matches folders alone, a `/`
 * at the start or in the middle anchors the pattern to the folder the file lies in, and any other pattern matches a
 * name at any depth below it. `base`: that folder, relative to the search root (`''` for the root itself).
 */
export interface IgnoreRule { base: string; pattern: string; negate: boolean; folderOnly: boolean; anchored: boolean }

/** The ignore files ripgrep reads in each folder, lowest precedence first: a later file's rule wins over an earlier one's. */
export const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'] as const

/** An ignore file's rules, `base` the folder it lies in; a comment, a blank line, or a pattern git would refuse, is skipped. */
export function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    line = line.replace(/^\\([#!])/, '$1').replace(/\\ /g, ' ')
    const folderOnly = line.endsWith('/')
    if (folderOnly) line = line.replace(/\/+$/, '')
    const anchored = line.includes('/')
    line = line.replace(/^\//, '')
    if (line === '') continue
    rules.push({ base, pattern: line, negate, folderOnly, anchored })
  }
  return rules
}

/**
 * Whether the rules leave out an entry at `path` (relative to the search root, `/` separated): the last rule that matches
 * decides, as in git, and a rule matches only below the folder its file lies in.
 */
export function isIgnored(rules: readonly IgnoreRule[], path: string, folder: boolean): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.folderOnly && !folder) continue
    const below = rule.base === '' ? path : path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : null
    if (below === null) continue
    const subject = rule.anchored ? below : below.slice(below.lastIndexOf('/') + 1)
    if (globMatches(subject, rule.pattern)) ignored = !rule.negate
  }
  return ignored
}

/**
 * Whether a file passes the call's own glob, as ripgrep's --glob reads one: a glob with a `/` is matched against the path
 * from the search root, any other against the file's name; a leading `!` leaves out what it matches instead.
 */
export function passesGlob(glob: string | undefined, path: string): boolean {
  if (glob === undefined) return true
  const exclude = glob.startsWith('!')
  const pattern = (exclude ? glob.slice(1) : glob).replace(/^\//, '')
  const subject = pattern.includes('/') ? path : path.slice(path.lastIndexOf('/') + 1)
  return globMatches(subject, pattern) !== exclude
}

function globMatches(subject: string, pattern: string): boolean {
  return matchesPattern(subject, pattern)
}

// ---- The glob matcher ----
//
// Not node:path's matchesGlob, which ignores case on Windows and macOS and reads a backslash as a separator, where
// ripgrep and git match case and read a backslash as an escape. A pattern is read as ripgrep reads one: `*` and `?` stay
// within one name, `**` crosses folders (`**/` for none or more whole names, `/**` for what lies beneath), `[abc]`, `[a-z]`, and
// `[!abc]` match one character, `{a,b}` is a choice, and `\` escapes the character after it. Matching is a walk over
// the set of places in the pattern the text so far could be at, so its cost is the text times the pattern, never more.

type Token =
  | { kind: 'char'; value: string }
  | { kind: 'one' }
  | { kind: 'set'; negate: boolean; ranges: Array<[string, string]> }
  /** `*`: any run of characters but `/`. */
  | { kind: 'run' }
  /** A globstar at the end: any run of characters, `/` too. */
  | { kind: 'any' }
  /** A globstar before a slash: none, or folders each ending in `/`. */
  | { kind: 'folders' }

/** The longest pattern read, and the most choices its braces may spell out; a pattern past either matches nothing. */
const MAX_PATTERN_LENGTH = 1_024
const MAX_CHOICES = 64
const compiled = new Map<string, Token[][] | null>()

/** Whether `subject` (`/` separated) matches `pattern`, case kept and a backslash an escape, on every platform. */
export function matchesPattern(subject: string, pattern: string): boolean {
  let choices = compiled.get(pattern)
  if (choices === undefined) {
    choices = pattern.length > MAX_PATTERN_LENGTH ? null : expandBraces(pattern)?.map(tokens) ?? null
    if (compiled.size >= 2_000) compiled.clear()
    compiled.set(pattern, choices)
  }
  return choices !== null && choices.some(parts => matchesTokens(subject, parts))
}

/** The patterns a pattern's braces spell out, `{a,b}c` as `ac` and `bc`; null where there are more than MAX_CHOICES. */
function expandBraces(pattern: string): string[] | null {
  const open = firstBrace(pattern)
  if (open === null) return [pattern]
  const [start, end, alternatives] = open
  const out: string[] = []
  for (const alternative of alternatives) {
    const rest = expandBraces(pattern.slice(0, start) + alternative + pattern.slice(end + 1))
    if (rest === null) return null
    out.push(...rest)
    if (out.length > MAX_CHOICES) return null
  }
  return out
}

/** The first `{...}` with a comma at its own level (an escaped brace and one in a class do not count): where it opens and closes, and its alternatives. */
function firstBrace(pattern: string): [number, number, string[]] | null {
  for (let start = 0; start < pattern.length; start++) {
    const character = pattern[start]!
    if (character === '\\') { start++; continue }
    if (character === '[') { start = classEnd(pattern, start) ?? start; continue }
    if (character !== '{') continue
    const alternatives: string[] = []
    let depth = 0
    let from = start + 1
    for (let at = start + 1; at < pattern.length; at++) {
      const here = pattern[at]!
      if (here === '\\') { at++; continue }
      if (here === '[') { at = classEnd(pattern, at) ?? at; continue }
      if (here === '{') depth++
      else if (here === ',' && depth === 0) { alternatives.push(pattern.slice(from, at)); from = at + 1 }
      else if (here === '}') {
        if (depth > 0) { depth--; continue }
        alternatives.push(pattern.slice(from, at))
        return alternatives.length > 1 ? [start, at, alternatives] : null
      }
    }
    return null
  }
  return null
}

/** Where the class opened at `start` closes, a `]` straight after the opening (or its `!`) being part of the class; null where it does not close. */
function classEnd(pattern: string, start: number): number | null {
  let at = start + 1
  if (pattern[at] === '!' || pattern[at] === '^') at++
  if (pattern[at] === ']') at++
  for (; at < pattern.length; at++) {
    if (pattern[at] === '\\') { at++; continue }
    if (pattern[at] === ']') return at
  }
  return null
}

function tokens(pattern: string): Token[] {
  const out: Token[] = []
  for (let at = 0; at < pattern.length; at++) {
    const character = pattern[at]!
    if (character === '\\') { out.push({ kind: 'char', value: pattern[++at] ?? '\\' }); continue }
    if (character === '?') { out.push({ kind: 'one' }); continue }
    if (character === '[') {
      const end = classEnd(pattern, at)
      if (end !== null) { out.push(classToken(pattern.slice(at + 1, end))); at = end; continue }
    }
    if (character !== '*') { out.push({ kind: 'char', value: character }); continue }
    let stars = 1
    while (pattern[at + stars] === '*') stars++
    const atStart = at === 0 || pattern[at - 1] === '/'
    const slash = pattern[at + stars] === '/'
    // `**` is a globstar only as a whole name (git's rule); beside other characters the stars are one.
    if (stars >= 2 && atStart && slash) { out.push({ kind: 'folders' }); at += stars; continue }
    if (stars >= 2 && atStart && at + stars === pattern.length) { out.push({ kind: 'any' }); at += stars - 1; continue }
    out.push({ kind: 'run' })
    at += stars - 1
  }
  return out
}

function classToken(body: string): Token {
  const negate = body.startsWith('!') || body.startsWith('^')
  const text = negate ? body.slice(1) : body
  const ranges: Array<[string, string]> = []
  for (let at = 0; at < text.length; at++) {
    let low = text[at]!
    if (low === '\\' && at + 1 < text.length) low = text[++at]!
    if (text[at + 1] === '-' && at + 2 < text.length) {
      let high = text[at + 2]!
      at += 2
      if (high === '\\' && at + 1 < text.length) high = text[++at]!
      ranges.push([low, high])
    } else ranges.push([low, low])
  }
  return { kind: 'set', negate, ranges }
}

function matchesTokens(subject: string, parts: readonly Token[]): boolean {
  // `places[i]` holds when the text so far can have used the first i tokens; `within` holds the folders tokens the text so far
  // ends inside a name of, which only a slash can end: a name cannot be left halfway (`**/foo` is not `xfoo`).
  let places = new Set<number>()
  let within = new Set<number>()
  const open = (set: Set<number>, index: number) => {
    set.add(index)
    // A run, a globstar, and folders can each match nothing, so the place after them is reached as well. A folders token
    // is only ever entered at the start or after a `/`, so passing it over here is at a name boundary.
    while (index < parts.length && (parts[index]!.kind === 'run' || parts[index]!.kind === 'any' || parts[index]!.kind === 'folders')) { index++; set.add(index) }
  }
  open(places, 0)
  for (const character of subject) {
    const next = new Set<number>()
    const nextWithin = new Set<number>()
    // A slash ends a name of the folders and starts the next (or the token after); any other character stays inside one.
    const inFolders = (index: number) => { if (character === '/') open(next, index); else nextWithin.add(index) }
    for (const index of places) {
      const part = parts[index]
      if (part === undefined) continue
      switch (part.kind) {
        case 'char': if (character === part.value) open(next, index + 1); break
        case 'one': if (character !== '/') open(next, index + 1); break
        case 'set': if (character !== '/' && inSet(part, character)) open(next, index + 1); break
        case 'run': if (character !== '/') open(next, index); break
        case 'any': open(next, index); break
        case 'folders': inFolders(index); break
      }
    }
    for (const index of within) inFolders(index)
    if (next.size === 0 && nextWithin.size === 0) return false
    places = next
    within = nextWithin
  }
  return places.has(parts.length)
}

function inSet(part: Extract<Token, { kind: 'set' }>, character: string): boolean {
  return part.ranges.some(([low, high]) => character >= low && character <= high) !== part.negate
}
