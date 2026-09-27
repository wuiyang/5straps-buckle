import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { JsonValue } from '@5straps/protocol'
import { z } from 'zod'
import type { PathView } from '../../../domain/path-view.js'
import { ToolExecutionError } from '../../../domain/tool.js'
import { describeProcessFailure } from '../process-failure.js'
import { buildChildEnvironment } from '../../../domain/environment.js'
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
  timeoutMs: number; signal: AbortSignal; authorizeRead: (path: string) => Promise<boolean>
}): Promise<JsonValue> {
  const root = input.paths.resolve(input.args.path)
  const environment = buildChildEnvironment({ parent: process.env, extra: {} })
  const glob = input.args.glob ? ['--glob', input.args.glob] : []
  const listed = await input.runProcess({ command: 'rg', args: ['--files', '--null', ...glob, '--', '.'], cwd: root, environment, timeoutMs: input.timeoutMs, signal: input.signal })
  if (listed.exitCode !== 0 && listed.exitCode !== 1) throw searchError(listed)
  const names = listed.stdout.split('\0')
  names.pop() // An unterminated final name may have been cut by the process output cap.
  const matches: JsonValue[] = []
  let truncated = listed.truncated || names.length > MAX_FILES
  let excludedFiles = 0
  for (const name of names.slice(0, MAX_FILES)) {
    input.signal.throwIfAborted()
    if (matches.length >= input.args.limit) { truncated = true; break }
    const path = resolve(root, name)
    const file = await openCandidate(path)
    if (!file) { excludedFiles += 1; continue }
    try {
      const canonical = await realpath(path)
      const held = await file.stat()
      const current = await stat(canonical)
      if (!held.isFile() || held.size > MAX_FILE_BYTES || held.ino !== current.ino || held.dev !== current.dev || !await input.authorizeRead(canonical)) {
        excludedFiles += 1
        continue
      }
      // Search the authorized open handle, never reopen a path that may have changed.
      const args = ['--json', '--line-number', '--max-count', String(input.args.limit - matches.length)]
      if (!input.args.caseSensitive) args.push('--ignore-case')
      args.push('--regexp', input.args.pattern, '--', '-')
      const result = await input.runProcess({ command: 'rg', args, stdin: file.fd, cwd: root, environment, timeoutMs: input.timeoutMs, signal: input.signal })
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

async function openCandidate(path: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
