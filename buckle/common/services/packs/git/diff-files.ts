import { ToolExecutionError } from '../../../domain/tool.js'

/**
 * The files a git diff lists, read from `git diff --raw --numstat -z` and never from the patch text, whose lines a file's
 * own content can spell (R1, D77): each file pair once, with its status letter, both modes, its path and, for a rename
 * or a copy, the path it came from, and its line counts.
 */
export interface ListedFile {
  /** git's status letter: A, C, D, M, R, T, U, or X. */
  status: string
  oldMode: string
  newMode: string
  /** The path a rename or a copy came from; null for every other status. */
  from: string | null
  path: string
  lines: { added: number; removed: number } | 'binary'
}

/** Why a file's content is not shown, as `[content hidden: <reason>]` names it; never a path or a value. */
export const HIDDEN = {
  credential: 'credential file',
  rule: 'read rule',
  link: 'link on its path',
  name: 'name Buckle cannot read',
  beneath: 'hidden file beneath it',
  unjudged: 'no read check',
} as const
export type HiddenReason = typeof HIDDEN[keyof typeof HIDDEN]

/** Constant: what git listed is never shown where it cannot be read whole. */
const UNREADABLE_LISTING = 'Buckle could not read the list of changed files git gave, so no diff is shown'

/** `:<old mode> <new mode> <old id> <new id> <status><score>`, a raw record's head, which its path or paths follow. */
const RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([ACDMRTUX])[0-9]{0,3}$/
/** `<added>\t<removed>\t<path>`, a numstat record; an empty path means a rename's or a copy's two paths follow. */
const NUMSTAT_RECORD = /^(-|[0-9]+)\t(-|[0-9]+)\t([\s\S]*)$/

/**
 * The files `git diff --raw --numstat -z` lists, refused rather than read in part. With `-z` every path is written as
 * it is and each field ends with a NUL, so a field is a path only where its record's place says so: a path that starts
 * with `:` or holds a tab or a newline is read whole. git writes every raw record, then a numstat record for each in the
 * same order; one that does not pair up, a combined record, or text after the last is refused.
 */
export function parseListing(output: string): ListedFile[] {
  if (output === '') return []
  if (!output.endsWith('\0')) throw unreadableListing()
  const fields = output.slice(0, -1).split('\0')
  let at = 0
  const next = (): string => {
    if (at >= fields.length) throw unreadableListing()
    return fields[at++]!
  }
  const raw: Array<Omit<ListedFile, 'lines'>> = []
  while (at < fields.length && fields[at]!.startsWith(':')) {
    const head = RAW_RECORD.exec(next())
    if (head === null) throw unreadableListing()
    const [, oldMode, newMode, status] = head as unknown as [string, string, string, string]
    const from = status === 'R' || status === 'C' ? next() : null
    raw.push({ status, oldMode, newMode, from, path: next() })
  }
  const files = raw.map(record => {
    const counts = NUMSTAT_RECORD.exec(next())
    if (counts === null) throw unreadableListing()
    const [, added, removed, named] = counts as unknown as [string, string, string, string]
    const from = named === '' ? next() : null
    const path = named === '' ? next() : named
    if (from !== record.from || path !== record.path) throw unreadableListing()
    const lines = added === '-' || removed === '-' ? 'binary' as const : { added: Number(added), removed: Number(removed) }
    return { ...record, lines }
  })
  if (at !== fields.length) throw unreadableListing()
  return files
}

export function unreadableListing(): ToolExecutionError {
  return new ToolExecutionError(UNREADABLE_LISTING, { code: 'GIT_FAILED' })
}

/** The paths a listed file names: the one it came from first, for a rename or a copy. */
export function pathsOf(file: ListedFile): string[] {
  return file.from === null ? [file.path] : [file.from, file.path]
}

/**
 * Hides each shown file one of whose paths is a folder above a path no check showed: a hidden file's, or an entry of
 * the index (`held`, git ls-files) that nothing listed. git reads a path it is handed as a folder too, so `a` handed to
 * the patch would print `a/.env` where HEAD holds the file `a` and the index the folder (R1). Hiding one may make a
 * folder above it hidden in turn, so this runs until nothing changes. `withheld` is updated in place.
 */
export function withholdBeneath(files: readonly ListedFile[], withheld: Map<ListedFile, HiddenReason>, held: readonly string[]): void {
  const shown = new Set(files.filter(file => !withheld.has(file)).flatMap(pathsOf))
  const folders = new Set<string>()
  const above = (path: string) => {
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) folders.add(path.slice(0, cut))
  }
  for (const path of [...files.flatMap(pathsOf), ...held]) if (!shown.has(path)) above(path)
  for (let changed = true; changed;) {
    changed = false
    for (const file of files) {
      if (withheld.has(file) || !pathsOf(file).some(path => folders.has(path))) continue
      withheld.set(file, HIDDEN.beneath)
      for (const path of pathsOf(file)) above(path)
      changed = true
    }
  }
}

/**
 * What a hidden file shows: git's header for it, with no `index` line, as the ids it holds would let a short secret be
 * guessed; its mode, rename, or copy lines; one stat line of the lines added and removed, or `binary`; and the reason in
 * place of every hunk. Paths are quoted as git quotes them by default (core.quotePath), so a newline in one never starts
 * a line of its own.
 */
export function hiddenEntry(file: ListedFile, reason: HiddenReason): string {
  const from = file.from ?? file.path
  const lines = [`diff --git ${quoted(`a/${from}`)} ${quoted(`b/${file.path}`)}`]
  if (file.status === 'U') lines.push('unmerged')
  else if (file.status === 'A') lines.push(`new file mode ${file.newMode}`)
  else if (file.status === 'D') lines.push(`deleted file mode ${file.oldMode}`)
  else if (file.oldMode !== file.newMode) lines.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`)
  if (file.from !== null) {
    const verb = file.status === 'C' ? 'copy' : 'rename'
    lines.push(`${verb} from ${quoted(file.from)}`, `${verb} to ${quoted(file.path)}`)
  }
  lines.push(file.lines === 'binary' ? 'stat: binary' : `stat: +${file.lines.added} -${file.lines.removed}`, `[content hidden: ${reason}]`)
  return `${lines.join('\n')}\n`
}

const C_ESCAPES: Readonly<Record<number, string>> = { 0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' }

/** A path as git's quote_c_style writes it: as it is, or in double quotes where a byte is a control, `"`, `\`, or past ASCII. */
function quoted(path: string): string {
  const bytes = Buffer.from(path, 'utf8')
  const plain = (byte: number) => byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c
  if (bytes.every(plain)) return path
  let text = '"'
  for (const byte of bytes) text += plain(byte) ? String.fromCharCode(byte) : C_ESCAPES[byte] ?? `\\${byte.toString(8).padStart(3, '0')}`
  return `${text}"`
}
