import { isUtf8 } from 'node:buffer'
import { ToolInputError } from '../../../domain/tool.js'

/** A line of a hunk: kept (` `), removed (`-`), or added (`+`), its text without the line ending, and how it ended. */
export interface DiffLine { kind: ' ' | '-' | '+'; text: string; crlf: boolean; noNewline: boolean }

export interface Hunk { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }

/** One file a unified diff touches: one it changes, one it creates (`--- /dev/null`), or one it deletes (`+++ /dev/null`). */
export interface FileChange { kind: 'modify' | 'create' | 'delete'; path: string; hunks: Hunk[] }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * The files a unified diff touches, read as `diff -u` and `git diff` write one: `---` and `+++` headers, with `a/` and
 * `b/` prefixes or without (stripped where both sides carry theirs, or one side is `/dev/null`), a tab and a timestamp
 * after a name ignored, a quoted name read as git quotes it, `/dev/null` for a file created or deleted, `@@` hunks whose
 * counts are kept to, and `\ No newline at end of file`. A line ending of CRLF is kept as found. Any other header line
 * (`diff --git`, `index`, a mode) is passed over. A rename, a copy, or a binary patch is refused, as nothing applies it.
 */
export function parseUnifiedDiff(text: string): FileChange[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const changes: FileChange[] = []
  let index = 0
  while (index < lines.length) {
    const line = withoutCr(lines[index]!)
    if (/^(rename|copy) (from|to) /.test(line)) throw new ToolInputError(`The patch renames or copies a file (${line}), which fs_apply_patch does not apply: move it with fs_move, then patch it`)
    if (line.startsWith('GIT binary patch') || /^Binary files .* differ$/.test(line)) throw new ToolInputError('The patch holds a binary change, which fs_apply_patch does not apply')
    if (!line.startsWith('--- ') || !withoutCr(lines[index + 1] ?? '').startsWith('+++ ')) { index++; continue }
    const oldName = headerName(line.slice(4))
    const newName = headerName(withoutCr(lines[index + 1]!).slice(4))
    index += 2
    const hunks: Hunk[] = []
    while (index < lines.length && withoutCr(lines[index]!).startsWith('@@ ')) {
      const read = readHunk(lines, index, newName ?? oldName ?? '')
      hunks.push(read.hunk)
      index = read.next
    }
    changes.push(fileChange(oldName, newName, hunks))
  }
  if (changes.length === 0) throw new ToolInputError('The patch holds no unified diff: each file needs a --- and a +++ line, then its @@ hunks')
  return changes
}

/**
 * A file's new content, every hunk applied in order with its context exact: each hunk where its lines stand, at the line
 * its header names or the nearest one after the hunk before it, and refused, naming the hunk, where they stand nowhere.
 * Kept lines keep the file's own endings; an added line ends with CRLF where the patch's line did, or where the file's
 * first line does, and with LF otherwise. A deleted file must be emptied by its hunks; a created one has none to match.
 */
export function applyHunks(change: FileChange, current: Buffer | null): Buffer {
  if (current !== null && !isUtf8(current)) throw new ToolInputError(`${change.path} is not UTF-8 text, which fs_apply_patch patches`)
  const file = current === null ? [] : splitLines(current.toString('utf8'))
  const crlf = file[0]?.ending === '\r\n'
  const out: string[] = []
  let cursor = 0
  for (const [index, hunk] of change.hunks.entries()) {
    const old = hunk.lines.filter(line => line.kind !== '+')
    const at = findHunk({ file, old, from: cursor, wanted: hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1 })
    if (at === null) throw new ToolInputError(`Hunk ${index + 1} of ${change.path} (${hunk.header}) does not match the file, so nothing was written`, { code: 'PATCH_DOES_NOT_APPLY' })
    for (const line of file.slice(cursor, at)) out.push(line.text + line.ending)
    let taken = at
    for (const line of hunk.lines) {
      if (line.kind === '+') { out.push(line.text + (line.noNewline ? '' : line.crlf || crlf ? '\r\n' : '\n')); continue }
      const kept = file[taken++]!
      if (line.kind === ' ') out.push(kept.text + kept.ending)
    }
    cursor = taken
  }
  for (const line of file.slice(cursor)) out.push(line.text + line.ending)
  const result = out.join('')
  if (change.kind === 'delete' && result !== '') throw new ToolInputError(`The patch deletes ${change.path} but its hunks leave lines in it, so nothing was written`, { code: 'PATCH_DOES_NOT_APPLY' })
  return Buffer.from(result, 'utf8')
}

interface FileLine { text: string; ending: '' | '\n' | '\r\n' }

function splitLines(content: string): FileLine[] {
  const lines: FileLine[] = []
  for (const match of content.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const raw = match[0]
    if (raw.endsWith('\r\n')) lines.push({ text: raw.slice(0, -2), ending: '\r\n' })
    else if (raw.endsWith('\n')) lines.push({ text: raw.slice(0, -1), ending: '\n' })
    else lines.push({ text: raw, ending: '' })
  }
  return lines
}

/**
 * Where a hunk's kept and removed lines stand in the file, at `wanted` or the nearest line to it, never before `from`.
 * Each must match a file line's text exactly; a line the hunk marks as ending the file without a newline must be the
 * file's last, so ending, and any other must end with one. A hunk with none of its own is placed at `wanted` alone.
 */
function findHunk(input: { file: readonly FileLine[]; old: readonly DiffLine[]; from: number; wanted: number }): number | null {
  const { file, old, from } = input
  const last = file.length - old.length
  if (old.length === 0) return input.wanted >= from && input.wanted <= file.length ? input.wanted : null
  const matches = (at: number) => old.every((line, offset) => {
    const standing = file[at + offset]!
    return standing.text === line.text && (standing.ending === '') === line.noNewline
  })
  for (let distance = 0; distance <= file.length; distance++) {
    for (const at of distance === 0 ? [input.wanted] : [input.wanted - distance, input.wanted + distance]) {
      if (at >= from && at <= last && matches(at)) return at
    }
    if (input.wanted - distance < from && input.wanted + distance > last) break
  }
  return null
}

function readHunk(lines: readonly string[], start: number, file: string): { hunk: Hunk; next: number } {
  const header = withoutCr(lines[start]!)
  const parsed = HUNK_HEADER.exec(header)
  if (!parsed) throw new ToolInputError(`A hunk header of ${file} is not one a unified diff writes: ${header}`)
  const [oldStart, oldCount, newStart, newCount] = [Number(parsed[1]), parsed[2] === undefined ? 1 : Number(parsed[2]), Number(parsed[3]), parsed[4] === undefined ? 1 : Number(parsed[4])]
  const hunk: Hunk = { header: header.slice(0, header.indexOf('@@', 2) + 2), oldStart, oldCount, newStart, newCount, lines: [] }
  let [oldLeft, newLeft] = [oldCount, newCount]
  let index = start + 1
  while (index < lines.length && (oldLeft > 0 || newLeft > 0 || lines[index]!.startsWith('\\'))) {
    const raw = lines[index]!
    if (raw.startsWith('\\')) {
      const previous = hunk.lines.at(-1)
      if (previous === undefined) throw new ToolInputError(`A hunk of ${file} opens with "${withoutCr(raw)}", which marks the line before it`)
      previous.noNewline = true
      index++
      continue
    }
    // A line with no marker at all is an empty kept line whose space an editor took off, where the hunk still has lines.
    const kind = raw === '' || raw === '\r' ? ' ' : raw[0]
    if (kind !== ' ' && kind !== '-' && kind !== '+') break
    const crlf = raw.endsWith('\r')
    hunk.lines.push({ kind, text: (crlf ? raw.slice(0, -1) : raw).slice(raw === '' || raw === '\r' ? 0 : 1), crlf, noNewline: false })
    if (kind !== '+') oldLeft--
    if (kind !== '-') newLeft--
    index++
  }
  if (oldLeft !== 0 || newLeft !== 0) throw new ToolInputError(`The hunk ${hunk.header} of ${file} holds other line counts than its header says, so nothing was written`)
  return { hunk, next: index }
}

function fileChange(oldName: string | null, newName: string | null, hunks: Hunk[]): FileChange {
  const [from, to] = stripPrefixes(oldName, newName)
  if (from === null && to === null) throw new ToolInputError('The patch names /dev/null on both sides of a file')
  if (from === null) return { kind: 'create', path: to!, hunks }
  if (to === null) return { kind: 'delete', path: from, hunks }
  if (from !== to) throw new ToolInputError(`The patch renames ${from} to ${to}, which fs_apply_patch does not apply: move it with fs_move, then patch it`)
  return { kind: 'modify', path: to, hunks }
}

/** `a/` and `b/` taken off where each side that names a file carries its own, as git writes them; kept otherwise. */
function stripPrefixes(from: string | null, to: string | null): [string | null, string | null] {
  const prefixed = (from === null || from.startsWith('a/')) && (to === null || to.startsWith('b/'))
  return prefixed ? [from?.slice(2) ?? null, to?.slice(2) ?? null] : [from, to]
}

/** A `---` or `+++` line's name: `/dev/null` as null, a tab and what follows it dropped, a quoted name read as git quotes it. */
function headerName(raw: string): string | null {
  const named = raw.startsWith('"') ? unquote(raw) : raw.split('\t')[0]!.replace(/\s+$/, '')
  if (named === '') throw new ToolInputError('A --- or +++ line of the patch names no file')
  return named === '/dev/null' ? null : named
}

/** A name git quoted (`"a/caf\303\251.txt"`): C escapes and octal bytes read back to the UTF-8 name, up to the closing quote. */
function unquote(raw: string): string {
  const bytes: number[] = []
  const escapes: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 }
  for (let index = 1; index < raw.length; index++) {
    const character = raw[index]!
    if (character === '"') break
    if (character !== '\\') { bytes.push(...Buffer.from(character, 'utf8')); continue }
    const next = raw[++index] ?? ''
    if (/^[0-7]{3}$/.test(raw.slice(index, index + 3))) { bytes.push(Number.parseInt(raw.slice(index, index + 3), 8)); index += 2; continue }
    bytes.push(escapes[next] ?? next.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
