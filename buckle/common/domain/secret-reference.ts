/**
 * Secret references (docs/user/how-to/secrets.md): text a call writes in place of a value Buckle reads for it, so the value never
 * passes through the agent. `{{file:<path>:NAME}}` names NAME in a dotenv file inside the workspace or a mount, by a
 * relative path. `{{env:<platform>:NAME}}` names a value a platform holds; the form is reserved, and refused until
 * platform values are supported. A bare `{{env:NAME}}` names no source and is refused, as is any other text written as a
 * reference.
 */

/** Why a platform reference is refused in this release: never passed through as text. */
export const PLATFORM_REASON = 'platform references are reserved and not supported yet'
/** Why a reference anywhere but the three places is refused. */
export const PLACES_REASON = 'references are read in shell words, browser fill values, and web_fetch headers only'
/** Why a value shorter than MIN_SECRET_LENGTH is refused: a shorter one would mask ordinary text. */
export const SHORT_REASON = 'too short to mask'
/** The shortest value a reference may carry, and the shortest encoding of one that is masked. */
export const MIN_SECRET_LENGTH = 8

/** What a value is shown as wherever text leaves Buckle. */
export function maskLabel(name: string): string {
  return `[secret:${name}]`
}

/** One `{{file:<path>:NAME}}` in a text: where it stands, as written, and what it names. */
export interface FileReference {
  raw: string
  start: number
  end: number
  /** The relative path as written. */
  path: string
  name: string
}

/** The references a text holds, or why the text is refused. */
export type ReferenceReading = { references: FileReference[] } | { refusal: string }

/**
 * Text written in a reference's shape: two braces, a scheme and its colon, then a body with no blank and no brace up to
 * the closing pair. JSX's `{{ color: 'red' }}` and a template's `{{ name }}` hold blanks or no scheme, and are not it.
 */
const SHAPED = /\{\{([A-Za-z][A-Za-z0-9_-]*):([^\s{}]*)\}\}/g
/** The start of a reference to a known scheme, however it is spaced or cased, so a near miss is refused, never passed. */
const KNOWN_START = /\{\{\s*(?:file|env)\s*:/gi
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLATFORM = /^[a-z0-9][a-z0-9-]*$/
const DRIVE = /^[A-Za-z]:/
const CONTROL = /[\u0000-\u001f\u007f]/
/** The longest path a reference may name, and how much of a refused reference a reason quotes. */
const MAX_PATH = 4_096
const QUOTED = 200

/**
 * The references in text found where references are read: each `{{file:<path>:NAME}}`, checked; a platform reference,
 * a bare `{{env:NAME}}`, a reference to another scheme, or one with a path or NAME outside the grammar refuses the text,
 * naming the form. Text with no `{{` holds none.
 */
export function readReferences(text: string): ReferenceReading {
  if (!text.includes('{{')) return { references: [] }
  const references: FileReference[] = []
  // A known scheme's start inside a shaped reference can only be that reference's own start, as its body holds no brace.
  const shapedStarts = new Set<number>()
  for (const match of text.matchAll(SHAPED)) {
    const raw = match[0]
    const start = match.index
    shapedStarts.add(start)
    const read = shapedReference(raw, match[1]!, match[2]!)
    if ('refusal' in read) return read
    references.push({ raw, start, end: start + raw.length, ...read })
  }
  for (const match of text.matchAll(KNOWN_START)) {
    if (shapedStarts.has(match.index)) continue
    return { refusal: `${quoted(text.slice(match.index, match.index + QUOTED))} is not written as a reference: write {{file:<path>:NAME}}, in lower case and with no blank` }
  }
  return { references }
}

/**
 * Whether text holds something written as a file or env reference, valid or not: refused anywhere references are not
 * read (PLACES_REASON). A near miss with blanks, or another scheme's shape, is plain text there.
 */
export function mentionsReference(text: string): boolean {
  if (!text.includes('{{')) return false
  for (const match of text.matchAll(SHAPED)) if (/^(?:file|env)$/i.test(match[1]!)) return true
  return false
}

function shapedReference(raw: string, scheme: string, body: string): { path: string; name: string } | { refusal: string } {
  const shown = quoted(raw)
  if (scheme === 'env') {
    const parts = body.split(':')
    if (parts.length === 1) return { refusal: `${shown} names no source: a bare env reference is not read; write {{file:<path>:${NAME.test(body) ? body : 'NAME'}}} for a file in the workspace, or {{env:<platform>:NAME}} once platform values are supported` }
    if (parts.length === 2 && PLATFORM.test(parts[0]!) && NAME.test(parts[1]!)) return { refusal: `${PLATFORM_REASON}: ${shown} names the platform ${parts[0]}` }
    return { refusal: `${shown} is not a platform reference: write {{env:<platform>:NAME}}, which is reserved` }
  }
  if (scheme !== 'file') {
    return { refusal: `${shown} names the source ${scheme.toLowerCase() === 'file' || scheme.toLowerCase() === 'env' ? `${scheme}, which is written in lower case` : `${scheme}, which Buckle does not read`}: write {{file:<path>:NAME}}` }
  }
  const colon = body.lastIndexOf(':')
  if (colon < 0) return { refusal: `${shown} names no NAME: write {{file:<path>:NAME}}` }
  const path = body.slice(0, colon)
  const name = body.slice(colon + 1)
  if (!NAME.test(name)) return { refusal: `${shown}: a reference's NAME is letters, digits, and _, not starting with a digit` }
  const refusal = referencePathRefusal(path)
  if (refusal) return { refusal: `${shown}: ${refusal}` }
  return { path, name }
}

/**
 * Why a reference's path is outside the grammar, or null: relative, with no leading /, no .. segment, and no drive
 * letter. A path secrets.files lists is held to the same.
 */
export function referencePathRefusal(path: string): string | null {
  if (path === '') return 'a reference names a file by its relative path, which is empty here'
  if (path.length > MAX_PATH) return `a reference's path is at most ${MAX_PATH} characters`
  if (CONTROL.test(path)) return 'a reference\'s path holds no control character'
  if (path.includes('\\')) return 'a reference\'s path separates its folders with /, never \\'
  if (path.startsWith('/')) return 'a reference\'s path is relative to the workspace, with no leading /'
  if (DRIVE.test(path)) return 'a reference\'s path names no drive letter'
  if (path.split('/').includes('..')) return 'a reference\'s path holds no .. segment'
  return null
}

function quoted(text: string): string {
  return text.length > QUOTED ? `${text.slice(0, QUOTED)}...` : text
}
