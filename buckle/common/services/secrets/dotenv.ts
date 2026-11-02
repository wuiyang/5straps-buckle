/**
 * A dotenv file as a secret reference reads it (docs/user/how-to/secrets.md): `NAME=value` lines, each may start with `export `;
 * blanks around the `=`; a value in double quotes takes the escapes \n, \r, \t, \\, and \", in single quotes is
 * taken as written, and either may span lines; an unquoted value ends at a `#` after a blank and has its blanks
 * trimmed; a line starting with `#` and a blank line are skipped; a later line for a NAME wins. Nothing is interpolated:
 * `${OTHER}` is that text. A carriage return before each line end (CRLF) and a byte order mark are dropped.
 */

/** What a file holds for each NAME it defines, or the NAMEs whose line Buckle cannot read, which name no value. */
export interface DotenvReading {
  values: Map<string, string>
  /** NAMEs on a line that does not read as dotenv (an unclosed quote, text after a closing one). */
  unreadable: Set<string>
}

const ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/
const DOUBLE_ESCAPES: Readonly<Record<string, string>> = { 'n': '\n', 'r': '\r', 't': '\t', '\\': '\\', '"': '"' }

export function readDotenv(text: string): DotenvReading {
  const values = new Map<string, string>()
  const unreadable = new Set<string>()
  const source = (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n/g, '\n')
  let at = 0
  while (at < source.length) {
    const lineEnd = endOfLine(source, at)
    const line = source.slice(at, lineEnd)
    const assigned = ASSIGNMENT.exec(line)
    if (!assigned) {
      at = lineEnd + 1
      continue
    }
    const name = assigned[1]!
    const rest = line.slice(assigned[0].length)
    const valueAt = at + assigned[0].length + (rest.length - rest.trimStart().length)
    const quote = source[valueAt]
    if (quote === '"' || quote === '\'') {
      const read = quoted(source, valueAt + 1, quote)
      if (read === null) {
        unreadable.add(name)
        // An unclosed quote takes the rest of the file, as no later line can be told apart from its value.
        break
      }
      const after = source.slice(read.end, endOfLine(source, read.end))
      if (/^[ \t]*(?:#.*)?$/.test(after)) {
        values.set(name, read.value)
        unreadable.delete(name)
      } else unreadable.add(name)
      at = endOfLine(source, read.end) + 1
      continue
    }
    values.set(name, unquoted(rest))
    unreadable.delete(name)
    at = lineEnd + 1
  }
  for (const name of unreadable) values.delete(name)
  return { values, unreadable }
}

function endOfLine(text: string, from: number): number {
  const end = text.indexOf('\n', from)
  return end < 0 ? text.length : end
}

/** A quoted value from just past its opening quote: its text and where its closing quote ends, or null where none closes it. */
function quoted(text: string, from: number, quote: '"' | '\''): { value: string; end: number } | null {
  let value = ''
  for (let index = from; index < text.length; index++) {
    const character = text[index]!
    if (character === quote) return { value, end: index + 1 }
    if (quote === '"' && character === '\\' && index + 1 < text.length) {
      const next = text[index + 1]!
      const escaped = DOUBLE_ESCAPES[next]
      value += escaped ?? `\\${next}`
      index++
      continue
    }
    value += character
  }
  return null
}

/** An unquoted value: the line after the `=` up to a `#` that follows a blank, its blanks trimmed; `A=#x` is `#x`. */
function unquoted(rest: string): string {
  const comment = /[ \t]#/.exec(rest)
  return (comment ? rest.slice(0, comment.index) : rest).trim()
}
