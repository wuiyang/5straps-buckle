import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { baseCommand } from '../common/domain/argv.js'
import { allForms, commandForms } from '../common/domain/command-forms.js'

/**
 * Slice 7f review and the slice reading rule: Buckle must read a superset of the commands a shell runs, so a denied
 * command a heredoc or a continuation carries is always shown to the approver and the policy. This runs every heredoc
 * and continuation shape under real bash with a harmless sentinel in place of the dangerous command, and asserts that
 * every sentinel invocation bash ran is among the commands Buckle read on the same text. No git push and no network:
 * the sentinel only appends its arguments to a file. It skips when bash is absent, and says so.
 */
const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

if (!hasBash) console.info('heredoc oracle: bash is not on PATH, so the real-bash differential is skipped')

/** The dangerous command each shape carries, a sentinel that only records that it ran. `mark` shows its argument too. */
const SENTINEL = 'sentinel'
const PAYLOAD = `${SENTINEL} mark`

/** The command a shape runs the heredoc with: `cat` expands only its substitutions, `bash` runs the whole body. */
const COMMANDS = ['cat', 'bash'] as const

/** Delimiter kinds: unquoted, the three quoted forms, and `<<` against `<<-` (leading tabs stripped). */
const DELIMITERS = [
  { open: 'EOF', dash: false },
  { open: "'EOF'", dash: false },
  { open: '"EOF"', dash: false },
  { open: '\\EOF', dash: false },
  { open: 'EOF', dash: true },
  { open: "'EOF'", dash: true },
] as const

/** Where the payload sits in the body: plain, in substitutions under each quoting, behind escapes, continued, spanning lines, under find. */
const PLACEMENTS: Record<string, string[]> = {
  plain: [PAYLOAD],
  doubleQuotedSubstitution: [`echo "$(${PAYLOAD})"`],
  singleQuotedSubstitution: [`echo '$(${PAYLOAD})'`],
  backtickSubstitution: ['echo "`' + PAYLOAD + '`"'],
  escapedDollar: [`echo "\\$(${PAYLOAD})"`],
  escapedBacktick: ['echo "\\`' + PAYLOAD + '\\`"'],
  continuationOne: [`${SENTINEL} \\`, 'mark'],
  continuationTwo: [`${PAYLOAD} \\\\`, 'echo done'],
  continuationThree: [`${SENTINEL} \\\\\\`, 'mark'],
  continuationFour: [`${PAYLOAD} \\\\\\\\`, 'echo done'],
  doubleQuoteSpanningLines: ['echo "', `$(${PAYLOAD})`, '"'],
  findExec: [`find . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;`],
  // find re-reads its -exec command and does not re-split its words, so these reach the sentinel only through the
  // body's own readings, not the statement-piece backstop: they exercise the fed-shell view's escape resolution.
  findExecDoubleQuoted: [`find . -maxdepth 0 -exec true "$(${PAYLOAD})" \\;`],
  findExecEscapedDollar: [`find . -maxdepth 0 -exec true "\\$(${PAYLOAD})" \\;`],
  findExecEscapedBacktick: ['find . -maxdepth 0 -exec true "\\`' + PAYLOAD + '\\`" \\;'],
}

/** Heredocs nested one in another, one to three deep, the payload at the bottom; the outer fed to a shell. */
const NESTED: Array<{ label: string; body: string }> = [
  { label: 'nest1 quoted bash body, inner unquoted cat', body: `bash <<'EOF'\ncat <<X\necho "$(${PAYLOAD})"\nX\nEOF` },
  { label: 'nest2 cat in cat in bash', body: `bash <<'EOF'\ncat <<X\ncat <<Y\necho "$(${PAYLOAD})"\nY\nX\nEOF` },
  { label: 'nest3 four heredocs deep', body: `bash <<'EOF'\ncat <<W\ncat <<X\ncat <<Y\necho "$(${PAYLOAD})"\nY\nX\nW\nEOF` },
  { label: 'nest unquoted cat, substitution spanning a nested body', body: `cat <<EOF\n$(cat <<X\nx '$("\nfind . -maxdepth 0 -exec true " ;${PAYLOAD}; " \\;\n")'\nX\n)\nEOF` },
]

function shapeBody(command: string, delimiter: { open: string; dash: boolean }, lines: string[]): string {
  const tab = delimiter.dash ? '\t' : ''
  const redirect = delimiter.dash ? '<<-' : '<<'
  const indented = lines.map(line => tab + line).join('\n')
  return `${command} ${redirect}${delimiter.open}\n${indented}\n${tab}EOF`
}

function allShapes(): Array<{ label: string; body: string }> {
  const shapes: Array<{ label: string; body: string }> = []
  for (const command of COMMANDS) {
    for (const delimiter of DELIMITERS) {
      for (const [name, lines] of Object.entries(PLACEMENTS)) {
        const kind = `${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`
        shapes.push({ label: `${command} ${kind} ${name}`, body: shapeBody(command, delimiter, lines) })
      }
    }
  }
  return [...shapes, ...NESTED]
}

/**
 * A sentinel invocation by its arguments, whitespace collapsed: a deny glob matches on the command and its argument
 * words, not on how tabs or spaces fall, and a `<<-` continuation leaves bash an argument a stray tab Buckle's
 * tab-stripped reading drops, which is no bypass. Comparing the normalised argument keeps the superset meaningful.
 */
const invocation = (args: string): string => args.replace(/\s+/g, ' ').trim()

/** The sentinel invocations Buckle read on the body: every command form whose name is the sentinel, by its arguments. */
function buckleRan(body: string): Set<string> {
  const forms = allForms(commandForms('bash', ['-c', body]))
  const ran = new Set<string>()
  for (const form of forms) if (baseCommand(form[0] ?? '') === SENTINEL) ran.add(invocation(form.slice(1).join(' ')))
  return ran
}

describe.skipIf(!hasBash)('heredoc and continuation shapes read a superset of what real bash runs', () => {
  let directory = ''
  let log = ''
  let environment: NodeJS.ProcessEnv = process.env

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'buckle-heredoc-oracle-'))
    const binary = join(directory, SENTINEL)
    log = join(directory, 'ran.log')
    writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SENTINEL_LOG"\n')
    chmodSync(binary, 0o755)
    environment = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, SENTINEL_LOG: log }
  })

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  /** The sentinel invocations real bash ran on the body, by their joined arguments; empty when bash ran it none. */
  const bashRan = (body: string): Set<string> => {
    writeFileSync(log, '')
    try {
      execFileSync('bash', ['-c', body], { env: environment, cwd: directory, stdio: 'ignore', timeout: 4000 })
    } catch {
      // A shape may exit non-zero (the sentinel is no git push); the sentinel still recorded whatever it ran.
    }
    return new Set(readFileSync(log, 'utf8').split('\n').slice(0, -1).map(invocation))
  }

  it('reads every sentinel command bash runs, for every shape, within the time budget', () => {
    const shapes = allShapes()
    const missed: string[] = []
    let overRead = 0
    for (const { label, body } of shapes) {
      const ran = bashRan(body)
      const read = buckleRan(body)
      for (const invocation of ran) if (!read.has(invocation)) missed.push(`${label}: bash ran [sentinel ${invocation}] that Buckle did not read`)
      if (ran.size === 0 && read.size > 0) overRead++
    }
    console.info(`heredoc oracle: ${shapes.length} shapes, ${overRead} read the sentinel where bash did not (over-reads, allowed)`)
    expect(missed).toEqual([])
  }, 20_000)
})
