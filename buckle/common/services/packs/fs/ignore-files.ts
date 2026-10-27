// node:path's matchesGlob, as the name search uses: a `*` stays within one name, `**` crosses folders.
import { matchesGlob } from 'node:path'

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
  // A pattern git reads as matching a folder's whole contents (`build/**`) matches its entries at any depth.
  return matchesGlob(subject, pattern) || (pattern.endsWith('/**') && subject.startsWith(`${pattern.slice(0, -3)}/`))
}
