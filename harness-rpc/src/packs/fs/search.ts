import type { JsonValue } from '@5straps/protocol'
import { z } from 'zod'
import type { PathView } from '../../domain/path-view.js'
import { ToolExecutionError } from '../../domain/tool.js'
import { describeProcessFailure } from '../process-failure.js'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { ProcessRunner } from '../../ports/process-runner.js'
import type * as schemas from './schemas.js'

const RIPGREP_NO_MATCHES_EXIT_CODE = 1

const matchSchema = z.object({
  type: z.literal('match'),
  data: z.object({
    path: z.object({ text: z.string() }),
    lines: z.object({ text: z.string() }),
    line_number: z.number().int(),
    submatches: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  }),
})

export async function searchContent(input: {
  args: z.output<typeof schemas.searchInput>
  paths: PathView
  runProcess: ProcessRunner
  timeoutMs: number
  signal: AbortSignal
}): Promise<JsonValue> {
  const root = input.paths.resolve(input.args.path)
  // --max-count bounds work per file; the global limit is applied while parsing.
  const commandArgs = ['--json', '--line-number', '--column', '--max-count', String(input.args.limit)]
  if (!input.args.caseSensitive) commandArgs.push('--ignore-case')
  if (input.args.glob) commandArgs.push('--glob', input.args.glob)
  commandArgs.push('--regexp', input.args.pattern, '--', '.')

  const result = await input.runProcess({
    command: 'rg',
    args: commandArgs,
    cwd: root,
    timeoutMs: input.timeoutMs,
    environment: buildChildEnvironment({ parent: process.env, extra: {} }),
    signal: input.signal,
  })

  if (result.exitCode !== 0 && result.exitCode !== RIPGREP_NO_MATCHES_EXIT_CODE) {
    throw new ToolExecutionError(describeProcessFailure('ripgrep', result), { code: 'SEARCH_FAILED' })
  }

  const matches = parseMatches(result.stdout, input.args.limit)
  return { matches, truncated: matches.length >= input.args.limit || result.truncated }
}

function parseMatches(output: string, limit: number): JsonValue[] {
  const matches: JsonValue[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    if (matches.length >= limit) break
    const parsed = matchSchema.safeParse(safeJsonParse(line))
    if (!parsed.success) continue
    matches.push({
      path: parsed.data.data.path.text,
      line: parsed.data.data.line_number,
      text: parsed.data.data.lines.text.replace(/\r?\n$/, ''),
      ranges: parsed.data.data.submatches.map(match => ({ start: match.start, end: match.end })),
    })
  }
  return matches
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
