import { constants } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'pathe'
import type { JsonValue } from '@5straps/protocol'
import { z } from 'zod'
import { isLinkedOnStateDevice, openHandleNoFollow } from '../../../adapters/beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { childPath, isPlainName, nativePath } from '../../../domain/paths.js'
import { ToolExecutionError } from '../../../domain/tool.js'
import { describeProcessFailure } from '../process-failure.js'
import { hostEnvironment, type HostEnvironment } from '../../../domain/environment.js'
import { ownRoots } from '../../../domain/executable.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import type * as schemas from './schemas.js'

const MAX_FILES = 5_000
const MAX_FILE_BYTES = 10 * 1_048_576
const matchSchema = z.object({
  type: z.literal('match'),
  data: z.object({
    lines: z.object({ text: z.string() }), line_number: z.number().int(),
    submatches: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  }),
})

export async function searchContent(input: {
  args: z.output<typeof schemas.searchInput>; paths: PathView; runProcess: ProcessRunner
  /** The absolute path ripgrep is spawned by (resolveProgram), never its bare name. */
  ripgrep: string
  timeoutMs: number; signal: AbortSignal; authorizeRead: (path: string) => Promise<boolean>
  /** A hard-linked file on the device of one of these is excluded, as fs_read refuses it. */
  protectedRoots: readonly string[]
  /** The host's unless a test imitates another: off Windows a listed name holding a backslash is left out. */
  platform?: NodeJS.Platform
  /** The environment ripgrep runs with, its PATH clear of every root an agent writes (hostEnvironment); the view's own roots alone when absent. */
  environment?: HostEnvironment
}): Promise<JsonValue> {
  const root = input.paths.resolve(input.args.path)
  const environment = (input.environment ?? hostEnvironment(() => ownRoots(input.paths), input.platform))()
  const glob = input.args.glob ? ['--glob', input.args.glob] : []
  const listed = await input.runProcess({ command: input.ripgrep, args: ['--files', '--null', ...glob, '--', '.'], cwd: root, environment, timeoutMs: input.timeoutMs, signal: input.signal })
  if (listed.exitCode !== 0 && listed.exitCode !== 1) throw searchError(listed)
  const names = listed.stdout.split('\0')
  names.pop() // An unterminated final name may have been cut by the process output cap.
  const matches: JsonValue[] = []
  let truncated = listed.truncated || names.length > MAX_FILES
  let excludedFiles = 0
  for (const name of names.slice(0, MAX_FILES)) {
    input.signal.throwIfAborted()
    if (matches.length >= input.args.limit) { truncated = true; break }
    const path = listedPath(root, name, input.platform ?? process.platform)
    const file = path === null ? null : await openCandidate(path)
    if (path === null || !file) { excludedFiles += 1; continue }
    try {
      const canonical = canonicalOf(await realpath(path))
      const held = await file.stat()
      const current = canonical === null ? null : await stat(canonical)
      if (canonical === null || current === null || !held.isFile() || held.size > MAX_FILE_BYTES || held.ino !== current.ino || held.dev !== current.dev || isLinkedOnStateDevice({ info: held, path: canonical, protectedRoots: input.protectedRoots, roots: [input.paths.root, ...input.paths.scratchRoots] }) || !await input.authorizeRead(canonical)) {
        excludedFiles += 1
        continue
      }
      // Search the authorized open handle, never reopen a path that may have changed.
      const args = ['--json', '--line-number', '--max-count', String(input.args.limit - matches.length)]
      if (!input.args.caseSensitive) args.push('--ignore-case')
      args.push('--regexp', input.args.pattern, '--', '-')
      const result = await input.runProcess({ command: input.ripgrep, args, stdin: file.fd, cwd: root, environment, timeoutMs: input.timeoutMs, signal: input.signal })
      if (result.exitCode !== 0 && result.exitCode !== 1) throw searchError(result)
      for (const line of result.stdout.split('\n')) {
        if (!line || matches.length >= input.args.limit) break
        const parsed = parseMatch(line)
        if (parsed) matches.push({ path: name, line: parsed.line_number, text: parsed.lines.text.replace(/\r?\n$/, ''), ranges: parsed.submatches })
      }
      truncated ||= result.truncated
    } finally {
      await file.close()
    }
  }
  return { matches, truncated: truncated || matches.length >= input.args.limit, excludedFiles }
}

/**
 * The path a name rg listed (`./src/a.ts`) names. Off Windows a segment that is not one plain name (a backslash, which
 * pathe reads as a separator) would name another path than the file rg found, so such a name is left out: null. There
 * the names are appended to the root as text (childPath), which pathe would fold onto a drive under `/` (`/c:/x`).
 */
function listedPath(root: string, name: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return resolve(root, name)
  const below = name.replace(/^\.\//, '')
  return below.split('/').every(isPlainName) ? childPath(root, below) : null
}

/** A real path in pathe's form; null for one pathe cannot name as the system does (nativePath), which is left out. */
function canonicalOf(real: string): string | null {
  try { return nativePath(real) } catch { return null }
}

async function openCandidate(path: string) {
  try {
    return await openHandleNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ELOOP', 'EACCES'].includes(String(error.code))) return null
    throw error
  }
}

function parseMatch(line: string) {
  try {
    const parsed = matchSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data.data : null
  } catch {
    // The bounded process output can end partway through a JSON record.
    return null
  }
}

function searchError(result: Parameters<typeof describeProcessFailure>[1]) {
  return new ToolExecutionError(describeProcessFailure('ripgrep', result), { code: 'SEARCH_FAILED' })
}
