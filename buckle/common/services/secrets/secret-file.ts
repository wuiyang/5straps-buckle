import { constants, readSync, realpathSync, statSync } from 'node:fs'
import { posix } from 'pathe'
import { withFileBeneath } from '../../adapters/beneath.js'
import type { SecretFileEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import { isInsideAny, nativePath } from '../../domain/paths.js'
import { ToolInputError } from '../../domain/tool.js'
import { readDotenv } from './dotenv.js'
import type { SecretPlan } from './places.js'

/** The largest file a reference may read: a dotenv file is small, and a larger one is no such file. */
export const MAX_SECRET_FILE_BYTES = 1_048_576

const refused = (message: string) => new ToolInputError(message, { code: 'PERMISSION_DENIED' })

/**
 * The real file a reference's path names (docs/secrets.md): the path as written is read from the workspace as the agent
 * sees it, so under a mounted view a path beneath a mount's target names that mount's file; every link is followed, and
 * where it lands must be a regular file inside the workspace's folder or the source of a mount the owner declared, never
 * a scratch root and never beyond. A path that names nothing is refused, naming the path.
 */
export function resolveSecretFile(written: string, view: PathView): string {
  const named = view.resolve(posix.join(view.displayRoot, written))
  let real: string
  try {
    real = nativePath(realpathSync.native(named))
  } catch (error) {
    if (isMissing(error)) throw refused(`The secret reference names ${written}, which does not exist in the workspace`)
    throw refused(`The secret reference names ${written}, which Buckle cannot resolve`)
  }
  const declared = view.mounts.filter(mount => !mount.scratch).map(mount => mount.source)
  if (!isInsideAny([view.root, ...declared], real)) throw refused(`The secret reference names ${written}, which lands outside the workspace and its mounts`)
  let isFile = false
  try { isFile = statSync(real).isFile() } catch { isFile = false }
  if (!isFile) throw refused(`The secret reference names ${written}, which is not a regular file`)
  return real
}

/**
 * The file a secrets.files entry lists (docs/secrets.md): the regular file at that path in the workspace or a mount,
 * reached through no link, or null. A link at the listed name, or at a folder above it, lists nothing, so a link planted
 * there, at a name missing or replaced, never moves the listing onto another file.
 */
export function listedSecretFile(written: string, view: PathView): string | null {
  try {
    const real = resolveSecretFile(written, view)
    return real === nativePath(view.resolve(posix.join(view.displayRoot, written))) ? real : null
  } catch {
    return null
  }
}

/**
 * The files a call's references name, each judged where it lands (resolveSecretFile) with the NAMEs the call reads from
 * it, so the rules ask about each before Buckle reads any (docs/secrets.md).
 */
export function secretFileEffects(plan: SecretPlan, view: PathView): SecretFileEffect[] {
  return [...plan.files].map(([written, names]) => {
    try {
      return { kind: 'secret_file', path: resolveSecretFile(written, view), written, names: [...names] }
    } catch (error) {
      // A refusal names the NAMEs the call would have read there too, never a value (docs/secrets.md).
      if (error instanceof ToolInputError) throw new ToolInputError(`${error.message}; the call reads ${names.join(', ')} from it`, { code: error.code })
      throw error
    }
  })
}

/**
 * The values a call's references name in one file, read at the moment the call runs (docs/secrets.md): the file is
 * opened where the rules judged it, beneath its pinned folder and never through a link, and read as dotenv. A link that
 * moved it since, a hard link on the disk that holds Buckle's state, a file over MAX_SECRET_FILE_BYTES, and a NAME it
 * does not define, or defines on a line Buckle cannot read, each refuse, naming the file and the NAME, never a value.
 */
export function readSecretValues(input: { real: string; written: string; names: readonly string[]; protectedRoots: readonly string[]; roots: readonly string[] }): Map<string, string> {
  const { real, written } = input
  let now: string
  try { now = nativePath(realpathSync.native(real)) } catch { throw refused(`The secret file ${written} is gone since the call was judged`) }
  if (now !== real) throw refused(`The secret file ${written} moved since the call was judged, so nothing was read`)
  const bytes = withFileBeneath(real, { flags: constants.O_RDONLY, shown: written, protectedRoots: input.protectedRoots, roots: input.roots }, descriptor => readBounded(descriptor, written))
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw refused(`The secret file ${written} is not UTF-8 text`) } finally { bytes.fill(0) }
  const reading = readDotenv(text)
  const values = new Map<string, string>()
  for (const name of input.names) {
    if (reading.unreadable.has(name)) throw refused(`The secret file ${written} defines ${name} on a line Buckle cannot read as dotenv`)
    const value = reading.values.get(name)
    if (value === undefined) throw refused(`The secret file ${written} does not define ${name}`)
    values.set(name, value)
  }
  reading.values.clear()
  return values
}

function readBounded(descriptor: number, written: string): Buffer {
  const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1)
  let size = 0
  for (;;) {
    const read = readSync(descriptor, buffer, size, buffer.length - size, null)
    if (read === 0) break
    size += read
    if (size > MAX_SECRET_FILE_BYTES) {
      buffer.fill(0)
      throw refused(`The secret file ${written} is larger than ${MAX_SECRET_FILE_BYTES} bytes`)
    }
  }
  const bytes = Buffer.from(buffer.subarray(0, size))
  buffer.fill(0)
  return bytes
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
