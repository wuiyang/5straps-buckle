import { parseArgs } from 'node:util'
import { asksForHelp } from './help-request.js'
import type { CliResult } from './result.js'
import { INIT_USAGE } from './usage.js'

export function parseInitArguments(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' }, root: { type: 'string' }, mount: { type: 'string' }, volume: { type: 'string', multiple: true }, name: { type: 'string' }, port: { type: 'string' }, out: { type: 'string' },
      yes: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
}

export function answerInitHelp(argv: string[]): CliResult | null {
  if (!asksForHelp(argv)) return null
  const { values } = parseInitArguments(argv)
  if (!values.help) return null
  process.stdout.write(INIT_USAGE)
  return { exitCode: 0 }
}
