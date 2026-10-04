import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { baseCommand } from '../common/domain/argv.js'
import { allForms, commandForms, type CommandForms, type ReadLimit, readLimitOf } from '../common/domain/command-forms.js'
import { leastProcessorTime } from './support/processor-time.js'

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

/**
 * One shape: its body, run as `bash -c`. `written` is the invocation Buckle reads where bash runs it expanded (an
 * over-read, see BACKTICK_EXTRA). `unread` is the limit the reading must name: the call is one Buckle cannot read
 * whole, so it is refused under any deny glob and asked at the floor (default D33 (b)), and what bash ran need not be
 * among the commands read. `whole` says the call must be read whole, with no limit, so a reading that marks it unread
 * fails the row as a miss would. `needs` names a program the shape runs that a machine may lack: where it is absent the
 * row is skipped and the reason logged; where it is present the sentinel must have run, so the row proves the program
 * runs it.
 */
interface Shape { label: string; body: string; written?: string; unread?: ReadLimit; whole?: true; needs?: string }

/** The dangerous command each shape carries, a sentinel that only records that it ran. `mark` shows its argument too. */
const SENTINEL = 'sentinel'
const PAYLOAD = `${SENTINEL} mark`

/** The command a shape runs the heredoc with: `cat` expands only its substitutions, `bash` runs the whole body. */
const COMMANDS = ['cat', 'bash'] as const

/** Delimiter kinds: unquoted and the three quoted forms, each under `<<` and `<<-` (leading tabs stripped). */
const DELIMITERS = [
  { open: 'EOF', dash: false },
  { open: "'EOF'", dash: false },
  { open: '"EOF"', dash: false },
  { open: '\\EOF', dash: false },
  { open: 'EOF', dash: true },
  { open: "'EOF'", dash: true },
  { open: '"EOF"', dash: true },
  { open: '\\EOF', dash: true },
] as const

/** A find line whose substitution only heredoc text or a fed shell runs: top-level shell text keeps it quoted. */
const FIND_SINGLE_QUOTED = `find . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;`

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
  findExec: [FIND_SINGLE_QUOTED],
  // find re-reads its -exec command and does not re-split its words, so these reach the sentinel only through the
  // body's own readings, not the statement-piece backstop: they exercise the fed-shell view's escape resolution.
  findExecDoubleQuoted: [`find . -maxdepth 0 -exec true "$(${PAYLOAD})" \\;`],
  findExecEscapedDollar: [`find . -maxdepth 0 -exec true "\\$(${PAYLOAD})" \\;`],
  findExecEscapedBacktick: ['find . -maxdepth 0 -exec true "\\`' + PAYLOAD + '\\`" \\;'],
  // A continuation swallows the first delimiter line: under an unquoted delimiter bash joins it into the body and
  // expands the find line as heredoc text; under a quoted one the body ends there and the find line is shell text.
  swallowedDelimiter: ['x \\', 'EOF', FIND_SINGLE_QUOTED],
  // A body fed to bash runs the inner heredoc, which expands the single-quoted substitution whatever the outer quoting.
  nestedSingleQuotedFind: ['cat <<X', FIND_SINGLE_QUOTED, 'X'],
  // A double quote spanning three body lines: a fed shell runs the middle line's substitution inside it.
  doubleQuoteSpanningFind: ['find . -maxdepth 0 -exec true "', `find . -maxdepth 0 -exec true ' $(${PAYLOAD}) ' \\;`, '" \\;'],
}

/** Heredocs nested one in another, one to three deep, the payload at the bottom; the outer fed to a shell. */
const NESTED: Shape[] = [
  { label: 'nest1 quoted bash body, inner unquoted cat', body: `bash <<'EOF'\ncat <<X\necho "$(${PAYLOAD})"\nX\nEOF` },
  { label: 'nest2 cat in cat in bash', body: `bash <<'EOF'\ncat <<X\ncat <<Y\necho "$(${PAYLOAD})"\nY\nX\nEOF` },
  { label: 'nest3 four heredocs deep', body: `bash <<'EOF'\ncat <<W\ncat <<X\ncat <<Y\necho "$(${PAYLOAD})"\nY\nX\nW\nEOF` },
  { label: 'nest unquoted cat, substitution spanning a nested body', body: `cat <<EOF\n$(cat <<X\nx '$("\nfind . -maxdepth 0 -exec true " ;${PAYLOAD}; " \\;\n")'\nX\n)\nEOF` },
]

/**
 * Every heredoc and continuation shape the slice 7e and 7f reviews and the slice 7f report ran under real bash that
 * the generated table does not already hold, the sentinel in place of their `git push`. Rows where bash runs nothing
 * stay: they pin the over-reads, the safe direction.
 */
const REVIEW_SHAPES: Shape[] = [
  { label: '7e review: find five substitutions deep, the innermost double-quoted', body: `cat <<EOF\n$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(${PAYLOAD})" \\;)" \\;)" \\;)" \\;)" \\;)" \\;)\nEOF` },
  { label: '7e review: find five substitutions deep, an unescaped semicolon', body: `cat <<EOF\n$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(${PAYLOAD})" ;)" ;)" ;)" ;)" ;)" ;)\nEOF` },
  { label: '7f review: find five substitutions deep, the innermost unquoted', body: `cat <<EOF\n$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true $(${PAYLOAD}) \\;)" \\;)" \\;)" \\;)" \\;)" \\;)\nEOF` },
  { label: '7f review: a backtick in single quotes on a find line', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\`${PAYLOAD}\`' \\;\nEOF` },
  { label: '7f review: a quote that ends with its line', body: `bash <<'EOF'\necho 'x\n${PAYLOAD}\nEOF` },
  { label: '7f review: a body holding another heredoc marker', body: `bash <<'EOF'\ncat <<X\nhello\nX\n${PAYLOAD}\nEOF` },
  { label: '7f review: << inside arithmetic, no heredoc', body: `echo $((1<<2))\n${PAYLOAD}` },
  { label: '7f review: a command split over three continued lines, quoted', body: `bash <<'EOF'\n${SENTINEL} \\\npush \\\nmark\nEOF` },
  { label: '7f review: a backslash on the last body line, quoted', body: `bash <<'EOF'\n${PAYLOAD} \\\nEOF` },
  { label: '7f review: a backslash on the last body line, unquoted', body: `bash <<EOF\n${PAYLOAD} \\\nEOF` },
  { label: '7f review: an escaped backslash before a newline, quoted (no join)', body: `bash <<'EOF'\n${SENTINEL} \\\\\nmark\nEOF` },
  { label: '7f review: an unclosed $( on a body line', body: `cat <<EOF\n$(${PAYLOAD}\nEOF` },
  { label: '7f review: a backtick in single quotes in double quotes', body: `cat <<EOF\nfind . -maxdepth 0 -exec true "'\`${PAYLOAD}\`'" \\;\nEOF` },
  { label: '7f review: two heredocs on one line, the payload in the second', body: `cat <<A <<B\na\nA\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nB` },
  { label: '7f review: a delimiter with a quoted middle, E\'O\'F', body: `bash <<E'O'F\n${PAYLOAD}\nEOF` },
  { label: '7f review: a <<- delimiter line with a space after the tabs', body: `cat <<-EOF\n\t EOF\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nEOF` },
  { label: '7f review: a line the delimiter only prefixes', body: `cat <<EOF\nEOFX\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nEOF` },
  { label: '7f review: ${x:-$(...)} on a find line', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\${x:-$(${PAYLOAD})}' \\;\nEOF` },
  { label: '7f review: ${x=$(...)} on a find line', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\${x=$(${PAYLOAD})}' \\;\nEOF` },
  { label: '7f review: a heredoc inside single-quoted bash -c', body: `bash -c 'cat <<EOF\nfind . -maxdepth 0 -exec true "$(${PAYLOAD})" \\;\nEOF'` },
  { label: '7f review: a substitution spanning body lines', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '$(\n${PAYLOAD}\n)' \\;\nEOF` },
  { label: '7f review: a substitution continued by a backslash-newline', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '$(${SENTINEL} \\\nmark)' \\;\nEOF` },
  { label: '7f review: an escaped backslash before the command, unquoted', body: `bash <<EOF\n\\\\${PAYLOAD}\nEOF` },
  { label: '7f review: an escaped backslash before the command, unquoted, --force', body: `bash <<EOF\n\\\\${SENTINEL} --force mark\nEOF` },
  { label: '7f review: an escaped backslash before the command, quoted', body: `bash <<'EOF'\n\\\\${PAYLOAD}\nEOF` },
  { label: '7f review: an escaped backslash before the command, quoted, --force', body: `bash <<'EOF'\n\\\\${SENTINEL} --force mark\nEOF` },
  { label: '7f review: an escaped dollar on a find line, --force', body: `bash <<EOF\nfind . -maxdepth 0 -exec true "\\$(${SENTINEL} --force mark)" \\;\nEOF` },
  { label: '7f review: an escaped backtick on a find line, --force', body: `bash <<EOF\nfind . -maxdepth 0 -exec true "\\\`${SENTINEL} --force mark\\\`" \\;\nEOF` },
  { label: '7f review: an escaped backslash before --force, unquoted', body: `bash <<EOF\n${SENTINEL} \\\\--force mark\nEOF` },
  { label: '7f review: three trailing backslashes then --force, unquoted', body: `bash <<EOF\n${SENTINEL} \\\\\\\n--force mark\nEOF` },
  { label: '7f review: three trailing backslashes then --force, quoted', body: `bash <<'EOF'\n${SENTINEL} \\\\\\\n--force mark\nEOF` },
  { label: '7f report: find five substitutions deep, --force', body: `cat <<EOF\n$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true $(${SENTINEL} --force mark) \\;)" \\;)" \\;)" \\;)" \\;)" \\;)\nEOF` },
  { label: '7f report: $ and ( split by a backslash-newline', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '$\\\n(${PAYLOAD})' \\;\nEOF` },
  { label: '7f report: a double quote in a substitution spanning a find line', body: `cat <<EOF\n$(echo "a\nfind . -maxdepth 0 -exec true "; ${PAYLOAD})" \\;\nEOF` },
  { label: '7f report: a quoted newline in a substitution before the payload', body: `cat <<EOF\n$(echo "a\nb"; ${PAYLOAD})\nEOF` },
  { label: '7f report: an apostrophe in an earlier substitution', body: `cat <<EOF\n$(echo it's)\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nEOF` },
  { label: '7f report: an escaped dollar in single quotes on a find line', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\\$(${PAYLOAD})' \\;\nEOF` },
  { label: '7f report: find five substitutions deep, quoted delimiter', body: `cat <<'EOF'\n$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true "$(find . -maxdepth 0 -exec true $(${PAYLOAD}) \\;)" \\;)" \\;)" \\;)" \\;)" \\;)\nEOF` },
  { label: '7f report: a single-quoted substitution on a find line, --force', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '$(${SENTINEL} --force mark)' \\;\nEOF` },
  { label: '7f report: a continuation before --force, quoted', body: `bash <<'EOF'\n${SENTINEL} \\\n--force mark\nEOF` },
  { label: '7f report: a continuation before --force, unquoted', body: `bash <<EOF\n${SENTINEL} \\\n--force mark\nEOF` },
  { label: '7f report: two backslashes before --force, quoted', body: `bash <<'EOF'\n${SENTINEL} \\\\\n--force mark\nEOF` },
  { label: '7f report: two backslashes before --force, unquoted', body: `bash <<EOF\n${SENTINEL} \\\\\n--force mark\nEOF` },
  { label: '7f report: four backslashes before --force, unquoted', body: `bash <<EOF\n${SENTINEL} \\\\\\\\\n--force mark\nEOF` },
  { label: '7f report: two continuations around --force, quoted', body: `bash <<'EOF'\n${SENTINEL} \\\n--force \\\nmark\nEOF` },
  { label: '7f report: two continuations around --force, unquoted', body: `bash <<EOF\n${SENTINEL} \\\n--force \\\nmark\nEOF` },
  { label: '7f report: a <<- continuation before --force, quoted', body: `bash <<-'EOF'\n\t${SENTINEL} \\\n\t--force mark\n\tEOF` },
  { label: '7f report: a <<- continuation before --force, unquoted', body: `bash <<-EOF\n\t${SENTINEL} \\\n\t--force mark\n\tEOF` },
  { label: '7f report: a continuation into the delimiter line, quoted', body: `bash <<'EOF'\n${SENTINEL} --force \\\nEOF\necho after` },
  { label: '7f report: a continuation into the delimiter line, unquoted', body: `bash <<EOF\n${SENTINEL} --force \\\nEOF\necho after` },
  { label: '7f report: two backslashes on the line before the payload, quoted', body: `bash <<'EOF'\necho done \\\\\n${PAYLOAD}\nEOF` },
  { label: '7f report: two backslashes on the line before the payload, unquoted', body: `bash <<EOF\necho done \\\\\n${PAYLOAD}\nEOF` },
]

/**
 * The positive control: bash feeds the body to bash, which runs find, which runs the sentinel. If it records nothing,
 * no row can fail, so the oracle stops and names the cause rather than pass on nothing compared.
 */
const CONTROL = `bash <<'EOF'\nfind . -maxdepth 0 -exec ${SENTINEL} control \\;\nEOF`

/**
 * Adversarial heredoc shapes the slice 7g review could not run, each confirmed under real bash in scratch first:
 * fed-shell escape runs, parameter expansions and arithmetic carrying a substitution, two heredocs on one line, a
 * heredoc nested in a substitution nested in a heredoc nested in a substitution, bodies fed to sh, eval and source,
 * and CRLF line endings. Shapes needing an interpreter the test does not provide (dash, ssh) and bodies holding a
 * NUL byte or invalid UTF-8 (which the exec harness cannot pass) were confirmed in scratch only; the reader does not
 * crash on the latter and reads the command.
 */
const ADVERSARIAL: Shape[] = [
  { label: 'adversarial: escaped dollar, 1 backslashes', body: `bash <<EOF\nfind . -maxdepth 0 -exec true "\\$(${PAYLOAD})" \\;\nEOF` },
  { label: 'adversarial: unquoted substitution, 1 backslashes', body: `bash <<EOF\necho \\$(${PAYLOAD})\nEOF` },
  { label: 'adversarial: escaped command, 1 backslashes', body: `bash <<EOF\n\\${PAYLOAD}\nEOF` },
  { label: 'adversarial: continuation, 1 backslashes', body: `bash <<EOF\n${SENTINEL} \\\nmark\nEOF` },
  { label: 'adversarial: escaped dollar, 2 backslashes', body: `bash <<EOF\nfind . -maxdepth 0 -exec true "\\\\$(${PAYLOAD})" \\;\nEOF` },
  { label: 'adversarial: unquoted substitution, 2 backslashes', body: `bash <<EOF\necho \\\\$(${PAYLOAD})\nEOF` },
  { label: 'adversarial: escaped command, 2 backslashes', body: `bash <<EOF\n\\\\${PAYLOAD}\nEOF` },
  { label: 'adversarial: continuation, 2 backslashes', body: `bash <<EOF\n${SENTINEL} \\\\\nmark\nEOF` },
  { label: 'adversarial: continuation, 3 backslashes', body: `bash <<EOF\n${SENTINEL} \\\\\\\nmark\nEOF` },
  { label: 'adversarial: default-value substitution', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\${x:-$(${PAYLOAD})}' \\;\nEOF` },
  { label: 'adversarial: assign-default substitution', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\${x=$(${PAYLOAD})}' \\;\nEOF` },
  { label: 'adversarial: nested default substitution', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '\${x:-\${y:-$(${PAYLOAD})}}' \\;\nEOF` },
  { label: 'adversarial: arithmetic with a substitution', body: `cat <<EOF\nfind . -maxdepth 0 -exec true '$((1 + $(${PAYLOAD}) 0))' \\;\nEOF` },
  { label: 'adversarial: two heredocs, payload in the first', body: `cat <<A <<B\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nA\nb\nB` },
  { label: 'adversarial: two heredocs, payload in the second', body: `cat <<A <<B\na\nA\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nB` },
  { label: 'adversarial: two heredocs fed to bash, payload in the second', body: `bash <<A <<'B'\necho a\nA\n${PAYLOAD}\nB` },
  { label: 'adversarial: two heredocs, quoted first and unquoted second', body: `cat <<'A' <<B\n$(${PAYLOAD})\nA\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nB` },
  { label: 'adversarial: cat in $() in cat in $()', body: `echo "$(cat <<A\n$(cat <<B\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nB\n)\nA\n)"` },
  { label: 'adversarial: bash in $() in cat in $()', body: `echo "$(cat <<A\n$(bash <<'B'\n${PAYLOAD}\nB\n)\nA\n)"` },
  { label: 'adversarial: fed to bash: cat in $() in cat in $()', body: `bash <<'EOF'\necho "$(cat <<A\n$(cat <<B\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nB\n)\nA\n)"\nEOF` },
  { label: 'adversarial: sh, quoted body', body: `sh <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'adversarial: sh, unquoted, escaped dollar', body: `sh <<EOF\nfind . -maxdepth 0 -exec true "\\$(${PAYLOAD})" \\;\nEOF` },
  { label: 'adversarial: eval of cat', body: `eval "$(cat <<'EOF'\n${PAYLOAD}\nEOF\n)"` },
  { label: 'adversarial: eval of cat, quote spanning lines', body: `eval "$(cat <<'EOF'\nfind . -maxdepth 0 -exec true "\n$(${PAYLOAD})\n" \\;\nEOF\n)"` },
  { label: 'adversarial: source /dev/stdin', body: `source /dev/stdin <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'adversarial: . /dev/stdin', body: `. /dev/stdin <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'adversarial: CRLF find, bash', body: `bash <<EOF\r\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\r\nEOF\r\n` },
]

const backslashes = (count: number): string => '\\'.repeat(count)

/**
 * Slice 7h probes: inside a backtick body bash removes a backslash before `\`, a backtick or `$`, and before `"` when
 * double quotes hold the body, before it parses the body as commands, so `\\--force` there runs `--force`. Runs of 1 to
 * 8 backslashes before a flag and ending a word, in a backtick body at top level, in double quotes, under bash -c and
 * on a heredoc body line of every delimiter kind under cat and bash.
 */
function backtickShapes(): Shape[] {
  const shapes: Shape[] = []
  for (let run = 1; run <= 8; run++) {
    for (const [place, inner] of [['before a flag', `${SENTINEL} ${backslashes(run)}--force mark`], ['ending a word', `${SENTINEL} --force${backslashes(run)} mark`]] as const) {
      const substitution = `\`${inner}\``
      shapes.push({ label: `backtick run ${run} ${place}, top level`, body: `echo ${substitution}` })
      shapes.push({ label: `backtick run ${run} ${place}, in double quotes`, body: `echo "${substitution}"` })
      shapes.push({ label: `backtick run ${run} ${place}, under bash -c`, body: `bash -c 'echo ${substitution}'` })
      for (const command of COMMANDS) {
        for (const delimiter of DELIMITERS) shapes.push({ label: `backtick run ${run} ${place}, ${command} ${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`, body: shapeBody(command, delimiter, [`echo ${substitution}`]) })
      }
    }
  }
  return shapes
}

/**
 * Slice 7l: bash pairs the backslashes of a backtick body while it looks for the closing backtick, and removes a
 * backslash-newline whose backslash ends an odd run as a line continuation, single quotes in the body or not, before
 * it removes the escapes; so three backslashes and a newline inside a command word run the joined word. Runs of 1 to 9
 * before a newline, inside the command word and inside an argument, at top level, in double quotes, in `$()`, under
 * bash -c, single-quoted in the body, nested, nested in double quotes, and in a quoted body fed to bash. Each shape
 * ran under real bash in scratch first.
 */
function backtickContinuationShapes(): Shape[] {
  const shapes: Shape[] = []
  for (let run = 1; run <= 9; run++) {
    for (const [place, inner] of [['in the command word', `senti${backslashes(run)}\nnel mark`], ['in an argument', `${SENTINEL} a${backslashes(run)}\nmark b`]] as const) {
      const contexts = {
        'top level': `echo \`${inner}\``,
        'in double quotes': `echo "\`${inner}\`"`,
        'in $()': `echo $(echo \`${inner}\`)`,
        'under bash -c': `bash -c 'echo \`${inner}\`'`,
        'single-quoted in the body': `echo \`${inner.replace(`${SENTINEL} `, `${SENTINEL} '`)}'\``,
        'nested': `echo \`echo \\\`${inner}\\\`\``,
        'nested in double quotes': `echo "\`echo \\"\\\`${inner}\\\`\\"\`"`,
        'in a quoted body fed to bash': `bash <<'EOF'\necho \`${inner}\`\nEOF`,
      }
      for (const [context, body] of Object.entries(contexts)) shapes.push({ label: `backtick continuation run ${run} ${place}, ${context}`, body })
    }
  }
  return shapes
}

/** Backtick bodies nested, holding an escaped double quote, or ending in a backslash, each run under real bash in scratch first. */
const BACKTICK_EXTRA: Shape[] = [
  { label: 'backtick nested in a backtick, an escaped backslash before a flag', body: `echo \`echo \\\`${SENTINEL} \\\\\\\\--force mark\\\`\`` },
  { label: 'backtick in double quotes nested in one, an escaped backslash before a flag', body: `echo "\`echo \\"\\\`${SENTINEL} \\\\\\\\--force mark\\\`\\"\`"` },
  { label: 'backtick in double quotes, escaped double quotes around a flag', body: `echo "\`${SENTINEL} \\"--force\\" mark\`"` },
  { label: 'backtick in double quotes, an escaped backslash then an escaped double quote', body: `echo "\`${SENTINEL} \\\\\\"--force mark\`"` },
  { label: 'backtick fed to bash, escaped double quotes around a flag', body: `bash <<'EOF'\necho "\`${SENTINEL} \\"--force\\" mark\`"\nEOF` },
  { label: 'backtick as heredoc text, escaped double quotes stay', body: `cat <<EOF\necho "\`${SENTINEL} \\"--force\\" mark\`"\nEOF` },
  { label: 'backtick, four backslashes ending its body', body: `echo \`${SENTINEL} mark\\\\\\\\\`` },
  { label: 'bash -c, a backslash ending its body', body: `bash -c '${SENTINEL} --force\\'` },
  // Buckle expands no variable: it reads `$HOME` as written where bash runs the home directory. The command word is
  // read either way, so a deny glob on it still meets the call; the row counts as an over-read, never as a miss.
  { label: 'backtick, an escaped dollar (read as written)', body: `echo \`${SENTINEL} \\$HOME\``, written: '$HOME' },
]

/**
 * A comment inside a backtick body ends at the closing backtick, which bash finds before it reads the comment, so the
 * command after the substitution runs: at top level, under bash -c, in a nested body, past an escaped backtick or a
 * backslash-newline in the comment, and on a heredoc body line of every delimiter kind under cat and bash.
 */
function backtickCommentShapes(): Shape[] {
  const shapes: Shape[] = [
    { label: 'backtick comment, a statement after', body: `echo \`${PAYLOAD} # c\`; ${SENTINEL} two` },
    { label: 'backtick comment, a backtick after', body: `echo \`${PAYLOAD} # c\` \`${SENTINEL} two\`` },
    { label: 'backtick comment in double quotes, a statement after', body: `echo "\`${PAYLOAD} # c\`"; ${SENTINEL} two` },
    { label: 'backtick comment under bash -c, a statement after', body: `bash -c 'echo \`${PAYLOAD} # c\`; ${SENTINEL} two'` },
    { label: 'backtick comment holding an escaped backtick, a statement after', body: `echo \`${PAYLOAD} # c \\\` x\`; ${SENTINEL} two` },
    { label: 'backtick comment ended by a newline in the body', body: `echo \`${PAYLOAD} # c\n${SENTINEL} two\`` },
    { label: 'backtick comment continued by a backslash-newline, a statement after', body: `echo \`echo a # c \\\n${SENTINEL} two\`; ${SENTINEL} three` },
    { label: 'nested backtick comment, a statement after in the outer body', body: `echo \`echo \\\`${PAYLOAD} # c\\\`; ${SENTINEL} two\`` },
    // The escaped backtick in the comment closes nothing, so the second body pairs as bash pairs it and its view is read.
    { label: 'backtick comment holding an escaped backtick, then an escaped flag in a second body', body: `echo \`a # c \\\` x\`; echo \`${SENTINEL} \\\\--force mark\`` },
  ]
  for (const command of COMMANDS) {
    for (const delimiter of DELIMITERS) {
      const kind = `${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`
      shapes.push({ label: `backtick comment, a statement after, ${command} ${kind}`, body: shapeBody(command, delimiter, [`echo \`${PAYLOAD} # c\`; ${SENTINEL} two`]) })
      shapes.push({ label: `backtick comment, a backtick after, ${command} ${kind}`, body: shapeBody(command, delimiter, [`\`${PAYLOAD} # c\` \`${SENTINEL} two\``]) })
    }
  }
  return shapes
}

/**
 * Slice 7h probes: a run of 1 to 8 backslashes before a newline, on a body line of every delimiter kind under cat and
 * bash: after the sentinel, after its argument, and inside a word. Under `<<-EOF` bash strips the leading tabs of each
 * logical line only, so a line an odd run joins on keeps its tabs (five backslashes ran `\` and `mark`).
 */
function continuationRunShapes(): Shape[] {
  const shapes: Shape[] = []
  for (let run = 1; run <= 8; run++) {
    const placements = {
      'after the sentinel': [`${SENTINEL} ${backslashes(run)}`, 'mark'],
      'after its argument': [`${PAYLOAD} ${backslashes(run)}`, 'echo done'],
      'inside a word': [`${SENTINEL} --for${backslashes(run)}`, 'ce mark'],
    }
    for (const command of COMMANDS) {
      for (const delimiter of DELIMITERS) {
        for (const [place, lines] of Object.entries(placements)) shapes.push({ label: `continuation run ${run} ${place}, ${command} ${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`, body: shapeBody(command, delimiter, lines) })
      }
    }
  }
  return shapes
}

/**
 * Slice 7h probes: a shell whose script arrives as data, piped in, redirected, or handed over by xargs, runs what no
 * reading sees, so the call is unread (script as data); a heredoc on the shell's own statement and a -c string are
 * still read. Each shape ran the sentinel under real bash in scratch first.
 */
const SCRIPT_DATA: Shape[] = [
  { label: 'script as data: echo piped into bash', body: `echo '${PAYLOAD}' | bash`, unread: 'scriptData' },
  { label: 'script as data: printf piped into xargs -d newline bash -c', body: `printf '%s\\n' '${PAYLOAD}' | xargs -d '\\n' bash -c`, unread: 'scriptData' },
  { label: 'script as data: xargs -0 bash -c', body: `printf '%s\\0' '${PAYLOAD}' | xargs -0 bash -c`, unread: 'scriptData' },
  { label: 'script as data: xargs bash -c, a double-quoted item', body: `xargs bash -c <<'EOF'\n"${PAYLOAD}"\nEOF`, unread: 'scriptData' },
  { label: 'script as data: xargs bash -c, a single-quoted item', body: `xargs bash -c <<'EOF'\n'${PAYLOAD}'\nEOF`, unread: 'scriptData' },
  { label: 'script as data: xargs sh -c, an escaped space', body: `xargs sh -c <<'EOF'\n${SENTINEL}\\ mark\nEOF`, unread: 'scriptData' },
  { label: 'script as data: xargs bash -c, a bare word', body: `xargs bash -c <<'EOF'\n${SENTINEL}\nEOF`, unread: 'scriptData' },
  { label: 'script as data: xargs -I bash -c', body: `xargs -I{} bash -c {} <<'EOF'\n${PAYLOAD}\nEOF`, unread: 'scriptData' },
  { label: 'script as data: xargs -d newline bash -c, a heredoc', body: `xargs -d '\\n' bash -c <<'EOF'\n${PAYLOAD}\nEOF`, unread: 'scriptData' },
  { label: 'script as data: xargs env bash -c', body: `printf '%s\\n' '${PAYLOAD}' | xargs -d '\\n' env bash -c`, unread: 'scriptData' },
  { label: 'script as data: a heredoc piped to bash', body: `cat <<'A' | bash\n${PAYLOAD}\nA`, unread: 'scriptData' },
  { label: 'script as data: echo piped into sh -s', body: `echo '${PAYLOAD}' | sh -s`, unread: 'scriptData' },
  { label: 'script as data: echo piped into bash -', body: `echo '${PAYLOAD}' | bash -`, unread: 'scriptData' },
  { label: 'script as data: echo piped into bash /dev/stdin', body: `echo '${PAYLOAD}' | bash /dev/stdin`, unread: 'scriptData' },
  { label: 'script as data: echo piped into env bash', body: `echo '${PAYLOAD}' | env bash`, unread: 'scriptData' },
  { label: 'script as data: echo piped into a subshell running bash', body: `echo '${PAYLOAD}' | (bash)`, unread: 'scriptData' },
  { label: 'script as data: echo piped into a group running bash', body: `echo '${PAYLOAD}' | { bash; }`, unread: 'scriptData' },
  { label: 'script as data: echo piped into bash -c bash', body: `echo '${PAYLOAD}' | bash -c bash`, unread: 'scriptData' },
  { label: 'script as data: bash from a redirected file', body: `printf '%s\\n' '${PAYLOAD}' > s.sh; bash < s.sh`, unread: 'scriptData' },
  { label: 'script as data: bash from a here-string', body: `bash <<< '${PAYLOAD}'`, unread: 'scriptData' },
  { label: 'script as data: bash from a process substitution', body: `bash <(echo '${PAYLOAD}')`, unread: 'scriptData' },
  { label: 'script as data: source from a process substitution', body: `source <(echo '${PAYLOAD}')`, unread: 'scriptData' },
  { label: 'script as data: echo piped into source /dev/stdin', body: `echo '${PAYLOAD}' | source /dev/stdin`, unread: 'scriptData' },
  { label: 'script as data: echo piped into . /dev/stdin', body: `echo '${PAYLOAD}' | . /dev/stdin`, unread: 'scriptData' },
  { label: 'script as data: a pipe into bash with a heredoc on descriptor 3', body: `echo '${PAYLOAD}' | bash 3<<'EOF'\nx\nEOF`, unread: 'scriptData' },
  { label: 'script as data: echo piped into dash -s', body: `echo '${PAYLOAD}' | dash -s`, unread: 'scriptData' },
  { label: 'script read: a heredoc feeding bash after a pipe', body: `echo x | bash <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'script read: bash -s fed by its heredoc', body: `bash -s <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'script read: bash -c with a string after a pipe', body: `echo x | bash -c '${PAYLOAD}'` },
  { label: 'script read: bash --version after a pipe runs nothing', body: `echo '${PAYLOAD}' | bash --version` },
]

/**
 * Slice 7l: a shell or `source` whose script operand names its own input or another descriptor by any spelling of the
 * path, and a shell find hands a file name as its script, take the script as data; a shell -c string, a su -c string,
 * or an ssh remote command that an expansion supplies is text Buckle cannot know (expansion). Each is unread. A -c
 * string whose `$` sits in single quotes, and `{}` handed on as a positional, stay read. Each shape ran the sentinel
 * under real bash in scratch first, su and ssh as the stand-ins of STAND_INS.
 */
const UNREAD_INPUTS: Shape[] = [
  ...[
    ['echo piped into bash /dev//stdin', `echo '${PAYLOAD}' | bash /dev//stdin`],
    ['bash //dev/stdin from a file', `printf '%s\\n' '${PAYLOAD}' > s.sh; bash //dev/stdin < s.sh`],
    ['bash /proc/thread-self/fd/0 from a file', `printf '%s\\n' '${PAYLOAD}' > s.sh; bash /proc/thread-self/fd/0 < s.sh`],
    ['bash climbing to /dev/stdin from a file', `printf '%s\\n' '${PAYLOAD}' > s.sh; bash ../../../../../../../../dev/stdin < s.sh`],
    ['bash /dev/./stdin from a process substitution', `bash /dev/./stdin < <(echo '${PAYLOAD}')`],
    ['source //dev/stdin from a file', `printf '%s\\n' '${PAYLOAD}' > s.sh; source //dev/stdin < s.sh`],
    ['bash /dev/fd/3 from a here-string', `bash /dev/fd/3 3<<<'${PAYLOAD}'`],
    ['bash /dev/fd/3 from a process substitution', `bash /dev/fd/3 3< <(echo '${PAYLOAD}')`],
    ['bash /proc/self/fd/3 from a here-string', `bash /proc/self/fd/3 3<<<'${PAYLOAD}'`],
    ['source /dev/fd/3 from a here-string', `source /dev/fd/3 3<<<'${PAYLOAD}'`],
    ['. /dev/fd/3 from a here-string', `. /dev/fd/3 3<<<'${PAYLOAD}'`],
    ['find -exec bash -c {}', `: > '${PAYLOAD}'; find '${PAYLOAD}' -maxdepth 0 -exec bash -c {} \\;`],
    ['find -exec bash -c with {} inside its string', `: > '${PAYLOAD}'; find '${PAYLOAD}' -maxdepth 0 -exec bash -c 'true; {}' \\;`],
    ['find -exec bash {}', `printf '%s\\n' '${PAYLOAD}' > s.sh; find s.sh -maxdepth 0 -exec bash {} \\;`],
    ['find -exec env bash -c {}', `: > '${PAYLOAD}'; find '${PAYLOAD}' -maxdepth 0 -exec env bash -c {} \\;`],
    ['find -exec bash -c {} +', `: > '${PAYLOAD}'; find '${PAYLOAD}' -maxdepth 0 -exec bash -c {} +`],
  ].map(([label, body]) => ({ label: `script as data: ${label}`, body: body!, unread: 'scriptData' as const })),
  ...[
    ['bash -c of a substitution', `bash -c "$(echo '${PAYLOAD}')"`],
    ['sh -c of a variable', `x='${PAYLOAD}'; sh -c "$x"`],
    ['bash -c of printf', `bash -c "$(printf '%s %s' ${SENTINEL} mark)"`],
    ['bash -c of a variable inside its string', `x=mark; bash -c "${SENTINEL} $x"`],
    ['bash -c of a glob', `: > '${PAYLOAD}'; bash -c ${SENTINEL}*`],
    ['bash -c of a brace expansion', `bash -c {'${PAYLOAD}',x}`],
    ['env bash -c of a variable', `x='${PAYLOAD}'; env bash -c "$x"`],
    ['su -c of a variable', `x='${PAYLOAD}'; su -c "$x" root`],
    ['ssh with a remote command of a variable', `x='${PAYLOAD}'; ssh host "$x"`],
  ].map(([label, body]) => ({ label: `expansion: ${label}`, body: body!, unread: 'expansion' as const })),
  { label: 'read: a single-quoted -c string holding a variable (read as written)', body: `x=1; bash -c '${PAYLOAD} $x'`, written: 'mark $x' },
  { label: 'read: find handing {} to bash -c as $0', body: `find . -maxdepth 0 -exec bash -c '${PAYLOAD}' {} \\;` },
]

/** Real ssh with no configuration file and no known hosts: a ProxyCommand runs here before any connection, so nothing reaches the network. */
const REAL_SSH = '/usr/bin/ssh -F /dev/null -o BatchMode=yes -o UserKnownHostsFile=/dev/null'

/**
 * Slice 7l: env -S, an ssh command setting, and sudo -s or -i each parse their argument by rules of their own. Where
 * those rules are small and certain they are read exactly: env -S with no backslash and no `${` (six blanks, quotes, a
 * `#` comment), ssh's keyword as its configuration reader reads it and `%%` as `%`, and sudo -s words that read as
 * themselves. Anything else is unread (own parsing): an env escape or `${}`, an ssh `%` token, and a sudo -s word a
 * shell treats specially. env is the real program, ssh the real one at /usr/bin/ssh (its rows skip where that is
 * absent), and sudo the stand-in. Each ran the sentinel, or nothing where noted, in scratch first.
 */
const OWN_PARSING: Shape[] = [
  ...[
    ['env -S plain', `env -S '${PAYLOAD}'`],
    ['env -S with a vertical tab', `env -S $'${SENTINEL}\\vmark'`],
    ['env -S with a form feed', `env -S $'${SENTINEL}\\fmark'`],
    ['env -S with a carriage return', `env -S $'${SENTINEL}\\rmark'`],
    ['env -S with a comment', `env -S '${PAYLOAD} #x y'`],
    ['env -S with single quotes', `env -S "${SENTINEL} 'a b' mark"`],
    ['env -S with double quotes', `env -S '${SENTINEL} "a b" mark'`],
    ['env -S that is all comment (runs nothing)', `env -S '#x ${PAYLOAD}'`],
    ['sudo -s with plain words', `sudo -s ${PAYLOAD}`],
    ['sudo -i with an empty word', `sudo -i '' ${PAYLOAD}`],
  ].map(([label, body]) => ({ label: `own parsing read: ${label}`, body: body! })),
  ...[
    ['ssh -o plain', `${REAL_SSH} -o 'ProxyCommand=${PAYLOAD}' h true`],
    ['ssh -o with a quoted keyword', `${REAL_SSH} -o '"ProxyCommand" ${PAYLOAD}' h true`],
    ['ssh -o with a quoted keyword and =', `${REAL_SSH} -o '"ProxyCommand"=${PAYLOAD}' h true`],
    ['ssh -o with a quote inside the keyword', `${REAL_SSH} -o 'Proxy"Command" ${PAYLOAD}' h true`],
    ['ssh -o with an empty quoted word first', `${REAL_SSH} -o '"" ProxyCommand ${PAYLOAD}' h true`],
    ['ssh -o with two = signs', `${REAL_SSH} -o 'ProxyCommand==${PAYLOAD}' h true`],
    ['ssh -o with = between blanks', `${REAL_SSH} -o 'ProxyCommand = = ${PAYLOAD}' h true`],
    ['ssh -o with a tab', `${REAL_SSH} -o $'ProxyCommand\\t${PAYLOAD}' h true`],
    ['ssh -o with a carriage return', `${REAL_SSH} -o $'ProxyCommand\\r${PAYLOAD}' h true`],
    ['ssh -o in capitals', `${REAL_SSH} -o 'PROXYCOMMAND ${PAYLOAD}' h true`],
    ['ssh -o attached with a quoted keyword', `${REAL_SSH} '-o"ProxyCommand" ${PAYLOAD}' h true`],
    ['ssh -o with %%', `${REAL_SSH} -o 'ProxyCommand=${SENTINEL} %%r' h true`],
    ['ssh -o with trailing blanks', `${REAL_SSH} -o 'ProxyCommand=${PAYLOAD}   ' h true`],
  ].map(([label, body]) => ({ label: `own parsing read: ${label}`, body: body!, needs: '/usr/bin/ssh' })),
  ...[
    ['env -S with \\_', `env -S '${SENTINEL}\\_mark'`],
    ['env -S with \\c', `env -S '${PAYLOAD}\\c x'`],
    ['env -S with a leading \\_', `env -S '\\_${PAYLOAD}'`],
    ['env -S inside env -S', `env -S '-S\\_${SENTINEL}\\_mark'`],
    ['env -u then -S with \\_', `env -uX -S '${SENTINEL}\\_mark'`],
    ['nice env -S with \\_', `nice env -S 'nice\\_${SENTINEL}\\_mark'`],
    ['env -S with ${}', `NAME=${SENTINEL} env -S '\${NAME} mark'`],
    ['env --split-string= with \\_', `env --split-string='${SENTINEL}\\_mark'`],
    ['env -S attached with \\_', `env '-S${SENTINEL}\\_mark'`],
    ['sudo -s with a newline in the command word', `sudo -s $'senti\\nnel' mark`],
    ['sudo -i with a $', `export NAME=${SENTINEL}; sudo -i '$NAME' mark`],
  ].map(([label, body]) => ({ label: `own parsing unread: ${label}`, body: body!, unread: 'ownParsing' as const })),
  ...[
    ['ssh -o ProxyCommand with %r', `${REAL_SSH} -l ${SENTINEL} -o 'ProxyCommand=%r mark' h true`],
    ['ssh -o ProxyCommand with %h', `${REAL_SSH} -o 'ProxyCommand=%h mark' ${SENTINEL} true`],
    ['ssh -o ProxyCommand with %n', `${REAL_SSH} -o 'ProxyCommand=%n mark' ${SENTINEL} true`],
    ['ssh -o ProxyCommand with %r from user@host', `${REAL_SSH} -o 'ProxyCommand=%r mark' ${SENTINEL}@h true`],
    ['ssh -o ProxyCommand with %p', `${REAL_SSH} -o 'ProxyCommand=${PAYLOAD} %p' h true`],
  ].map(([label, body]) => ({ label: `own parsing unread: ${label}`, body: body!, unread: 'ownParsing' as const, needs: '/usr/bin/ssh' })),
]

/**
 * Owner decision D55: code a non-shell interpreter runs is unknown to Buckle, so the call is unread (unknown
 * interpreter) until a policy allows that interpreter. The two python shapes of the 7h probes ran the sentinel.
 */
const INTERPRETERS: Shape[] = [
  { label: 'interpreter: python os.system in a heredoc body', body: `python3 <<'EOF'\nimport os; os.system('${PAYLOAD}')\nEOF`, unread: 'interpreter' },
  { label: 'interpreter: python -c os.system', body: `python3 -c "import os; os.system('${PAYLOAD}')"`, unread: 'interpreter' },
  // Slice 7j: behind sudo, as the shell su -s names, and in the remote command of ssh (the stand-ins of STAND_INS).
  { label: 'interpreter: sudo python -c os.system', body: `sudo python3 -c "import os; os.system('${PAYLOAD}')"`, unread: 'interpreter' },
  { label: 'interpreter: su -s python -c os.system', body: `su -s python3 -c "import os; os.system('${PAYLOAD}')" root`, unread: 'interpreter' },
  { label: 'interpreter: ssh host python -c os.system', body: `ssh host "python3 -c \\"import os; os.system('${PAYLOAD}')\\""`, unread: 'interpreter' },
  // Slice 7j, default D57: awk runs a command through system() or a pipe, from its program argument, a -f file, or on
  // its input; tsx runs TypeScript that spawns one. Each ran the sentinel under real bash in scratch first (mawk as
  // awk, mawk, and nawk; tsx from the repository's own dependencies); where a program is absent its row is skipped.
  { label: 'interpreter: awk BEGIN system', body: `awk 'BEGIN{system("${PAYLOAD}")}'`, unread: 'interpreter', needs: 'awk' },
  { label: 'interpreter: mawk BEGIN system', body: `mawk 'BEGIN{system("${PAYLOAD}")}'`, unread: 'interpreter', needs: 'mawk' },
  { label: 'interpreter: nawk BEGIN system', body: `nawk 'BEGIN{system("${PAYLOAD}")}'`, unread: 'interpreter', needs: 'nawk' },
  { label: 'interpreter: gawk BEGIN system', body: `gawk 'BEGIN{system("${PAYLOAD}")}'`, unread: 'interpreter', needs: 'gawk' },
  { label: 'interpreter: awk -f a program file', body: `printf '%s\\n' 'BEGIN{system("${PAYLOAD}")}' > p.awk; awk -f p.awk`, unread: 'interpreter', needs: 'awk' },
  { label: 'interpreter: awk on piped input', body: `echo x | awk '{system("${PAYLOAD}")}'`, unread: 'interpreter', needs: 'awk' },
  { label: 'interpreter: awk printing to a pipe', body: `echo x | awk '{print | "${PAYLOAD}"}'`, unread: 'interpreter', needs: 'awk' },
  { label: 'interpreter: awk behind sudo', body: `sudo awk 'BEGIN{system("${PAYLOAD}")}'`, unread: 'interpreter', needs: 'awk' },
  { label: 'interpreter: awk in the remote command of ssh', body: `ssh host "awk 'BEGIN{system(\\"${PAYLOAD}\\")}'"`, unread: 'interpreter', needs: 'awk' },
  { label: 'interpreter: tsx -e child_process', body: `tsx -e "require('child_process').execSync('${PAYLOAD}')"`, unread: 'interpreter', needs: 'tsx' },
  // Slice 7l: the names CPython's free-threaded and debug builds and PyPy install (BUILD_NAMES links each to python3
  // here), and the C shells and busybox's shell applet, which Buckle does not read as a POSIX shell.
  { label: 'interpreter: python3.13t -c os.system', body: `python3.13t -c "import os; os.system('${PAYLOAD}')"`, unread: 'interpreter', needs: 'python3.13t' },
  { label: 'interpreter: python3-dbg -c os.system', body: `python3-dbg -c "import os; os.system('${PAYLOAD}')"`, unread: 'interpreter', needs: 'python3-dbg' },
  { label: 'interpreter: pypy3 -c os.system', body: `pypy3 -c "import os; os.system('${PAYLOAD}')"`, unread: 'interpreter', needs: 'pypy3' },
  { label: 'interpreter: tcsh -c', body: `tcsh -c '${PAYLOAD}'`, unread: 'interpreter', needs: 'tcsh' },
  { label: 'interpreter: csh -c', body: `csh -c '${PAYLOAD}'`, unread: 'interpreter', needs: 'csh' },
  { label: 'interpreter: busybox sh -c', body: `busybox sh -c '${PAYLOAD}'`, unread: 'interpreter', needs: 'busybox' },
]

/**
 * The 7h probes, folded in so they stay the regression: escape runs of 1 to 6 before a substitution, around a backtick
 * body, before a command and inside a continued substitution, and parameter expansions and arithmetic carrying a
 * substitution, each on a body line of every delimiter kind under cat and bash.
 */
const PROBE_PLACEMENTS: Record<string, string[]> = (() => {
  const placements: Record<string, string[]> = {}
  for (let run = 1; run <= 6; run++) {
    placements[`escapeRun${run}Dollar`] = [`find . -maxdepth 0 -exec true "${backslashes(run)}$(${PAYLOAD})" \\;`]
    placements[`escapeRun${run}Backtick`] = [`find . -maxdepth 0 -exec true "${backslashes(run)}\`${PAYLOAD}${backslashes(run)}\`" \\;`]
    placements[`escapeRun${run}Unquoted`] = [`echo ${backslashes(run)}$(${PAYLOAD})`]
    placements[`escapeRun${run}Command`] = [`${backslashes(run)}${PAYLOAD}`]
    placements[`escapeRun${run}FindContinuation`] = [`find . -maxdepth 0 -exec true '$(${SENTINEL} ${backslashes(run)}`, `mark)' \\;`]
  }
  return {
    ...placements,
    defaultSubstitution: [`echo "\${x:-$(${PAYLOAD})}"`],
    assignSubstitution: [`echo "\${x=$(${PAYLOAD})}"`],
    nestedDefaultSubstitution: [`echo "\${x:-\${y:-$(${PAYLOAD})}}"`],
    arithmeticSubstitution: [`echo $((1 + $(${PAYLOAD}) 0))`],
    findDefaultSubstitution: [`find . -maxdepth 0 -exec true '\${x:-$(${PAYLOAD})}' \\;`],
    findAssignSubstitution: [`find . -maxdepth 0 -exec true '\${x=$(${PAYLOAD})}' \\;`],
    findArithmeticSubstitution: [`find . -maxdepth 0 -exec true '$((1 + $(${PAYLOAD}) 0))' \\;`],
    findAlternateSubstitution: [`find . -maxdepth 0 -exec true '\${PWD:+$(${PAYLOAD})}' \\;`],
    findErrorSubstitution: [`find . -maxdepth 0 -exec true '\${PWD:?$(${PAYLOAD})}' \\;`],
  }
})()

/** 7h probes: CRLF line endings throughout, and CRLF body lines before an LF delimiter, for three placements of every kind. */
function crlfShapes(): Shape[] {
  const shapes: Shape[] = []
  const placements: Record<string, string[]> = { plain: [PAYLOAD], findExec: [FIND_SINGLE_QUOTED], continuation: [`${SENTINEL} \\`, 'mark'] }
  for (const command of COMMANDS) {
    for (const delimiter of DELIMITERS) {
      const kind = `${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`
      for (const [name, lines] of Object.entries(placements)) {
        shapes.push({ label: `crlf ${command} ${kind} ${name}`, body: `${shapeBody(command, delimiter, lines, '\r\n')}\r\n` })
        shapes.push({ label: `crlf-delimiter-lf ${command} ${kind} ${name}`, body: shapeBody(command, delimiter, lines.map(line => `${line}\r`)) })
      }
    }
  }
  return shapes
}

/**
 * 7h probes: heredocs fed to other consumers, two on one line, and nested in substitutions. `ssh` is a stand-in the
 * oracle puts on the PATH (STAND_INS), which runs the remote command here as the remote shell would, so nothing reaches
 * the network; `dash` and `python3` rows run nothing where those are absent, which hides no miss. An ssh with no
 * command opens an interactive session, which Buckle leaves unread (slice 7j).
 */
const PROBE_CONSUMERS: Shape[] = [
  { label: 'probe: two heredocs, bash runs the second', body: `bash <<A <<B\necho a\nA\n${PAYLOAD}\nB` },
  { label: 'probe: two heredocs, bash, payload expanded in the first', body: `bash <<A <<B\n$(${PAYLOAD})\nA\necho b\nB` },
  { label: 'probe: two heredocs, unquoted first, quoted second fed to bash', body: `bash <<A <<'B'\n$(echo a)\nA\n${PAYLOAD}\nB` },
  { label: 'probe: two heredocs on two commands of one line', body: `cat <<A; bash <<'B'\na\nA\n${PAYLOAD}\nB` },
  { label: 'probe: two heredocs, the second swallows its delimiter', body: `cat <<A <<B\na\nA\nx \\\nB\n${FIND_SINGLE_QUOTED}\nB` },
  { label: 'probe: cat in $() in bash in $(), quoted', body: `echo "$(bash <<'A'\necho "$(cat <<B\n${FIND_SINGLE_QUOTED}\nB\n)"\nA\n)"` },
  { label: 'probe: cat in backticks in cat in $()', body: `echo "$(cat <<A\n\`cat <<B\n${FIND_SINGLE_QUOTED}\nB\n\`\nA\n)"` },
  { label: 'probe: sh, quoted, nested cat', body: `sh <<'EOF'\ncat <<X\n${FIND_SINGLE_QUOTED}\nX\nEOF` },
  { label: 'probe: dash -s, quoted', body: `dash -s <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'probe: source <(cat)', body: `source <(cat <<'EOF'\n${PAYLOAD}\nEOF\n)`, unread: 'scriptData' },
  { label: 'probe: ssh host bash, quoted', body: `ssh host bash <<'EOF'\n${PAYLOAD}\nEOF` },
  { label: 'probe: ssh host bash -s, unquoted escape', body: `ssh host bash -s <<EOF\nfind . -maxdepth 0 -exec true "\\$(${PAYLOAD})" \\;\nEOF` },
  { label: 'probe: ssh host, no command', body: `ssh host <<'EOF'\n${PAYLOAD}\nEOF`, unread: 'session' },
  { label: 'probe: python -c of a shell body', body: `python3 -c "$(cat <<'EOF'\n${PAYLOAD}\nEOF\n)"`, unread: 'interpreter' },
  { label: 'probe: python stdin of a shell body', body: `python3 <<'EOF'\n${PAYLOAD}\nEOF`, unread: 'interpreter' },
]

/** 7h probes at top level: backtick escapes, an escaped backslash in $(), and a backslash-newline inside a word or a name. */
const PROBE_TOP_LEVEL: Shape[] = [
  { label: 'probe: top backtick, escaped backtick inside', body: `echo \`echo \\\`${PAYLOAD}\\\`\`` },
  { label: 'probe: top $(), escaped backslash before a flag', body: `echo $(${SENTINEL} \\\\--force mark)` },
  { label: 'probe: heredoc cat backtick, escaped backslash before a flag', body: `cat <<EOF\n\`${SENTINEL} \\\\\\\\--force mark\`\nEOF` },
  { label: 'probe: continuation inside a word', body: `${SENTINEL} --for\\\nce mark` },
  { label: 'probe: continuation inside the command name', body: `senti\\\nnel mark` },
  { label: 'probe: escaped backslash then continuation', body: `${SENTINEL} \\\\\\\nmark` },
  { label: 'probe: continuation after a space', body: `${SENTINEL} \\\nmark` },
  { label: 'probe: continuation in double quotes', body: `${SENTINEL} "--for\\\nce" mark` },
  // The single quotes keep the backslash-newline, so the sentinel gets one word holding a newline; it logs one line per
  // call, the newline as a space, which the invocation comparison already folds.
  { label: 'probe: continuation in single quotes (kept)', body: `${SENTINEL} '--for\\\nce' mark` },
  { label: 'probe: $() continuation inside a word', body: `echo $(${SENTINEL} --for\\\nce mark)` },
  { label: 'probe: backtick continuation inside a word', body: `echo \`${SENTINEL} --for\\\nce mark\`` },
]

/**
 * Stand-ins the oracle puts on the PATH for the wrappers a test cannot run: sudo and doas need a password or a rule
 * granting the call, su a password, and ssh a remote host. Each skips its program's options as that program's getopt
 * string reads them (sudo 1.9, OpenDoas, util-linux su, which permutes, and OpenSSH, which reads options again after
 * the host), then runs the command here: sudo and doas exec it (sudo -s and -i hand it to bash as one escaped string, as
 * sudo's manual says), su runs the shell with its last -c string, and ssh runs
 * the words after the host joined with spaces, as the remote shell would. With no command, sudo -i, sudo -s, doas -s,
 * su, and ssh run an interactive shell on their input. The stand-ins model those programs, so these rows check what
 * bash hands each one and what Buckle reads behind it; the option tables were checked against the real getopt strings,
 * and ssh's second pass after the host against real ssh -G (slice 7j probes).
 */
const STAND_INS: Record<string, string[]> = {
  sudo: [
    '#!/bin/sh',
    'session=',
    'while [ "$#" -gt 0 ]; do',
    '  case $1 in',
    '    --) shift; break ;;',
    '    --login|--shell) session=1; shift ;;',
    '    --auth-type|--close-from|--login-class|--chdir|--group|--host|--prompt|--chroot|--role|--type|--command-timeout|--other-user|--user) shift 2 ;;',
    '    --*) shift ;;',
    '    -?*)',
    '      rest=${1#-}; shift',
    '      while [ -n "$rest" ]; do',
    '        flag=${rest%"${rest#?}"}; rest=${rest#?}',
    '        case $flag in',
    '          i|s) session=1 ;;',
    '          a|C|c|D|g|h|p|R|r|T|t|U|u) [ -z "$rest" ] && shift; rest= ;;',
    '        esac',
    '      done ;;',
    '    *) break ;;',
    '  esac',
    'done',
    'while [ "$#" -gt 0 ]; do case $1 in *=*) export "$1"; shift ;; *) break ;; esac; done',
    // With -s or -i, the command goes to a shell as one string: each character but a letter, a digit, `_`, `$`, and
    // `-` escaped with a backslash, the words joined with spaces, as the sudo manual gives it.
    'if [ "$#" -gt 0 ] && [ -n "$session" ]; then',
    '  command=',
    '  for word do',
    '    rest=$word',
    '    while [ -n "$rest" ]; do',
    '      c=${rest%"${rest#?}"}; rest=${rest#?}',
    '      case $c in [[:alnum:]_\\$-]) command=$command$c ;; *) command=$command\\\\$c ;; esac',
    '    done',
    '    command="$command "',
    '  done',
    '  exec bash -c "${command% }"',
    'fi',
    '[ "$#" -gt 0 ] && exec "$@"',
    '[ -n "$session" ] && exec bash',
    'exit 1',
  ],
  doas: [
    '#!/bin/sh',
    'session=',
    'while getopts a:C:Lnsu: flag; do [ "$flag" = s ] && session=1; done',
    'shift $((OPTIND - 1))',
    '[ "$#" -gt 0 ] && exec "$@"',
    '[ -n "$session" ] && exec bash',
    'exit 1',
  ],
  su: [
    '#!/usr/bin/env bash',
    'shell=bash; commands=(); operands=()',
    'while (($#)); do',
    '  word=$1; shift',
    '  case $word in',
    '    --) operands+=("$@"); break ;;',
    '    --command=*|--session-command=*) commands+=("${word#*=}") ;;',
    '    --command|--session-command) commands+=("$1"); shift ;;',
    '    --shell=*) shell=${word#*=} ;;',
    '    --shell) shell=$1; shift ;;',
    '    --group|--supp-group|--whitelist-environment) shift ;;',
    '    --*) ;;',
    '    -?*)',
    '      rest=${word#-}',
    '      while [[ -n $rest ]]; do',
    '        flag=${rest:0:1}; rest=${rest:1}',
    '        case $flag in',
    '          c|s|g|G|u|w)',
    '            value=$rest; [[ -z $value ]] && { value=$1; shift; }',
    '            [[ $flag == c ]] && commands+=("$value"); [[ $flag == s ]] && shell=$value',
    '            rest= ;;',
    '        esac',
    '      done ;;',
    '    *) operands+=("$word") ;;',
    '  esac',
    'done',
    '[[ ${operands[0]} == - ]] && operands=("${operands[@]:1}")',
    'operands=("${operands[@]:1}")',
    'if ((${#commands[@]})); then exec "$shell" -c "${commands[-1]}" "${operands[@]}"; fi',
    'exec "$shell" "${operands[@]}"',
  ],
  ssh: [
    '#!/bin/sh',
    'spec=1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy',
    'while getopts "$spec" flag; do :; done',
    'terminated=; i=1',
    'for word do [ "$i" -eq $((OPTIND - 1)) ] && [ "$word" = -- ] && terminated=1; i=$((i + 1)); done',
    'shift $((OPTIND - 1))',
    '[ "$#" -gt 0 ] || exit 255',
    'shift',
    'if [ -z "$terminated" ] && [ "$#" -gt 0 ]; then',
    '  OPTIND=1',
    '  while getopts "$spec" flag; do :; done',
    '  shift $((OPTIND - 1))',
    'fi',
    '[ -n "$*" ] && exec bash -c "$*"',
    'exec bash',
  ],
}

/**
 * Slice 7i residual and owner decision D7: `sudo git push` was read as `sudo` alone, so a deny glob on the command it
 * runs never met it. The sentinel behind each wrapper and option shape, nested wrappers, wrappers in shell text, su's
 * -c string and the remote command of ssh as shell text: each ran the sentinel under real bash in scratch first, the
 * plain wrappers as themselves and sudo, doas, su, and ssh as the stand-ins above.
 */
function wrappedShapes(): Shape[] {
  const prefixes = [
    'sudo', 'sudo -u root', 'sudo -uroot', 'sudo -n -E', 'sudo -nE -u root', 'sudo -g wheel', 'sudo -h host', 'sudo -p prompt', 'sudo -C 3',
    'sudo -D /', 'sudo -T 10', 'sudo -U root', 'sudo -r role -t type', 'sudo -a type', 'sudo -c class', 'sudo --user=root', 'sudo --user root',
    'sudo --preserve-env', 'sudo --preserve-env=PATH', 'sudo --', 'sudo X=1', 'sudo -i', 'sudo -s', 'sudo --login', 'sudo --shell', 'sudo -iu root',
    'sudo -k', 'sudo -H -P -B -b', 'sudo --chdir /', 'sudo --other-user root', 'sudo --login-class class',
    'doas', 'doas -u root', 'doas -n', 'doas -nu root', 'doas -a style', 'doas --',
    'ssh host', 'ssh -p 22 host', 'ssh host -p 22', 'ssh -l user host', 'ssh -i key host', 'ssh -o User=me host', 'ssh -oUser=me host', 'ssh -J jump host',
    'ssh -t host', 'ssh -T host', 'ssh host --', 'ssh -- host', 'ssh -46 host', 'ssh -P tag host', 'ssh -I lib host', 'ssh -E ssh.log host',
    'ssh -b 0.0.0.0 host', 'ssh -c aes128-ctr host', 'ssh -m hmac-sha2-256 host', 'ssh -F none host', 'ssh -B lo host', 'ssh -e none host',
    'ssh -S none host', 'ssh -w any host', 'ssh -D 1080 host', 'ssh -L 1:h:2 host', 'ssh -R 1:h:2 host', 'ssh host -l user -p 22',
    'ssh -q -v -x -X -Y -C -A -a -k -g -K -M -y host',
    'env', 'env -u HOME', 'env X=1', 'env --', 'env -C .', 'env --chdir=.', 'env --unset=HOME X=1', 'nice', 'nice -n 5', 'nice -5',
    'nice --adjustment=5', 'nohup', 'timeout 5', 'timeout -s KILL 5', 'timeout -k 1 5', 'timeout --foreground 5', 'timeout -s TERM -k 1 --foreground 5',
    'timeout --preserve-status 5', 'time', 'time -p', 'stdbuf -oL', 'stdbuf -i0 -o0 -e0', 'stdbuf --output=L', 'ionice', 'ionice -c 3', 'ionice -c2 -n7',
    'chrt -o 0', 'chrt --other 0', 'chrt -b 0', 'chrt -i 0', 'chrt -f 1', 'command', 'command -p', 'builtin', 'exec', 'exec -a name', 'setsid', 'setsid -w',
    'sudo env X=1 nice', 'sudo -u root env X=1 nice -n 5 timeout 5', 'doas sudo', 'ssh host sudo', 'sudo ssh host', 'env sudo -u root', 'nohup sudo',
    'time sudo', 'command sudo', 'sudo command', 'timeout 5 ssh -p 22 host env X=1', 'X=1 sudo', 'sudo -u root -- env -- nice --',
  ]
  const bodies = [
    `su -c '${PAYLOAD}' root`, `su root -c '${PAYLOAD}'`, `su - root -c '${PAYLOAD}'`, `su -l root -c '${PAYLOAD}'`, `su -lc '${PAYLOAD}' root`,
    `su --command='${PAYLOAD}' root`, `su --command '${PAYLOAD}' root`, `su --session-command '${PAYLOAD}' root`, `su -s bash -c '${PAYLOAD}' root`,
    `su root -- -c '${PAYLOAD}'`, `su -c'${PAYLOAD}' root`, `su -m -p -f -P -c '${PAYLOAD}' root`, `su -g wheel -c '${PAYLOAD}' root`,
    `su -G wheel -c '${PAYLOAD}' root`, `su -w PATH -c '${PAYLOAD}' root`, `su --shell=bash -c '${PAYLOAD}' root`, `su -c 'echo x' -c '${PAYLOAD}' root`,
    `su -c '${PAYLOAD}; ${SENTINEL} two' root`, `sudo su -c '${PAYLOAD}' root`, `su -c 'sudo ${PAYLOAD}' root`, `ssh host "su -c '${PAYLOAD}' root"`,
    `su root -c '${PAYLOAD}' extra`,
    `ssh host '${PAYLOAD}; ${SENTINEL} two'`, `ssh host ${SENTINEL} 'mark;' ${SENTINEL} two`, `ssh host "${SENTINEL} 'a b'"`, `ssh host echo '$(${SENTINEL} inner)'`,
    `ssh host 'echo "$(${SENTINEL} inner)"'`, `ssh host "${PAYLOAD} | cat"`, `ssh host 'if true; then ${PAYLOAD}; fi'`,
    `if sudo ${PAYLOAD}; then :; fi`, `true && sudo ${PAYLOAD}`, `echo "$(sudo ${PAYLOAD})"`, `x=1 sudo ${PAYLOAD}`, `bash -c 'sudo ${PAYLOAD}'`,
    `eval 'sudo ${PAYLOAD}'`, `find . -maxdepth 0 -exec sudo ${PAYLOAD} \\;`, `sudo bash -c '${PAYLOAD}'`, `sudo sh -c '${PAYLOAD}'`,
  ]
  return [
    ...prefixes.map(prefix => ({ label: `wrapper: behind ${prefix}`, body: `${prefix} ${PAYLOAD}` })),
    ...bodies.map(body => ({ label: `wrapper: ${body}`, body })),
  ]
}

/** An ssh or su with no command, and sudo -i, sudo -s, or doas -s with none, run what arrives on their input: an interactive session, unread. */
const SESSIONS: Shape[] = [
  ['ssh host, no command, input empty', 'ssh host </dev/null'],
  ['echo piped into ssh host', `echo '${PAYLOAD}' | ssh host`],
  ['echo piped into ssh -p 22 host', `echo '${PAYLOAD}' | ssh -p 22 host`],
  ['echo piped into ssh host with an empty command', `echo '${PAYLOAD}' | ssh host ''`],
  ['echo piped into su', `echo '${PAYLOAD}' | su`],
  ['echo piped into su -', `echo '${PAYLOAD}' | su -`],
  ['echo piped into su - root', `echo '${PAYLOAD}' | su - root`],
  ['echo piped into sudo -i', `echo '${PAYLOAD}' | sudo -i`],
  ['echo piped into sudo -s', `echo '${PAYLOAD}' | sudo -s`],
  ['echo piped into sudo -iu root', `echo '${PAYLOAD}' | sudo -iu root`],
  ['echo piped into sudo --login', `echo '${PAYLOAD}' | sudo --login`],
  ['echo piped into sudo -i X=1', `echo '${PAYLOAD}' | sudo -i X=1`],
  ['echo piped into doas -s', `echo '${PAYLOAD}' | doas -s`],
  ['echo piped into env ssh host', `echo '${PAYLOAD}' | env ssh host`],
  ['echo piped into sudo ssh host', `echo '${PAYLOAD}' | sudo ssh host`],
  ['echo piped into sudo su', `echo '${PAYLOAD}' | sudo su`],
  ['su - root fed a heredoc', `su - root <<'EOF'\n${PAYLOAD}\nEOF`],
  ['sudo -s fed a heredoc', `sudo -s <<'EOF'\n${PAYLOAD}\nEOF`],
].map(([label, body]) => ({ label: `session: ${label}`, body: body!, unread: 'session' as const }))

/**
 * Slice 7l, the 7h to 7k review: the control above proves bash, find, and the sentinel work, but nothing proved the
 * stand-ins ran their commands, so a broken stand-in turned its rows into ones that pass on nothing (a broken su
 * dropped 23 rows silently). Each stand-in, sudo's shell form included, must record its marker before any row runs.
 */
const STAND_IN_CONTROLS: Record<string, readonly [string, string]> = {
  sudo: [`sudo -u root ${SENTINEL} sudo-control`, 'sudo-control'],
  'sudo -s': [`sudo -s ${SENTINEL} 'sudo shell-control'`, 'sudo shell-control'],
  doas: [`doas -u root ${SENTINEL} doas-control`, 'doas-control'],
  su: [`su -c '${SENTINEL} su-control' root`, 'su-control'],
  ssh: [`ssh -p 22 host ${SENTINEL} ssh-control`, 'ssh-control'],
}

/**
 * How long one shape may run: bash and the core tools start in milliseconds; a program a row `needs` (tsx, awk, a
 * shell) may take seconds from a cold cache. The whole table, 2,333 shapes, takes some 16 s here; its budget
 * leaves room for a loaded machine, and each shape's own timeout still bounds a shape that hangs.
 */
const SHAPE_TIMEOUT = 4_000
const NEEDS_TIMEOUT = 30_000
const ORACLE_BUDGET = 180_000

/** `levels` quoted heredocs fed to bash, one in another, around `inner`: past MAX_DEPTH (8) the innermost body is read line by line only. */
const fedDeep = (levels: number, inner: string): string => {
  const open = Array.from({ length: levels }, (_, index) => `bash <<'E${index}'`).join('\n')
  const close = Array.from({ length: levels }, (_, index) => `E${levels - 1 - index}`).join('\n')
  return `${open}\n${inner}\n${close}`
}

/**
 * Slice 7l: rbash, ash, mksh, yash, and posh are POSIX shells, read as bash is: a -c string is read, and a script piped
 * in arrives as data. A row runs only where its shell is installed.
 */
const OTHER_SHELLS: Shape[] = ['rbash', 'ash', 'mksh', 'yash', 'posh'].flatMap(shell => [
  { label: `other shell: ${shell} -c`, body: `${shell} -c '${PAYLOAD}'`, needs: shell },
  { label: `other shell: echo piped into ${shell}`, body: `echo '${PAYLOAD}' | ${shell}`, unread: 'scriptData' as const, needs: shell },
  { label: `other shell: ${shell} fed a quoted heredoc`, body: `${shell} <<'EOF'\n${PAYLOAD}\nEOF`, needs: shell },
])

/** Names an interpreter installs under that a test machine rarely has: each is linked to python3 in the oracle's directory. */
const BUILD_NAMES = ['python3.13t', 'python3-dbg', 'pypy3']

/**
 * Rows that pin readings the tables above reach twice (the 7h mutation survivors): a double quote spanning lines in a
 * body three heredocs deep, which only a nested body read whole sees (M5); and two bodies past MAX_DEPTH, where the call
 * is unread 'depth' and only the line readings remain, so the run of 2 (mod 4) backslashes that bash halves into a
 * continuation (M6) and a single-quoted substitution in a heredoc nested in heredoc text (M8) are read by them alone.
 */
const READING_PINS: Shape[] = [
  { label: 'pin: a double quote spanning lines three heredocs deep', body: `bash <<'A'\nbash <<'B'\nbash <<'C'\nfind . -maxdepth 0 -exec true "\nfind . -maxdepth 0 -exec true ' $(${PAYLOAD}) ' \\;\n" \\;\nC\nB\nA` },
  { label: 'pin: two backslashes before a newline in an unquoted body past MAX_DEPTH', body: fedDeep(8, `bash <<EOF\n${SENTINEL} \\\\\nmark\nEOF`) },
  { label: 'pin: a single-quoted substitution in a heredoc in heredoc text past MAX_DEPTH', body: fedDeep(8, `cat <<EOF\n$(cat <<X\nfind . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;\nX\n)\nEOF`) },
]

/**
 * Slice 7l: a `#` starts a comment only where bash's read_token starts a word, after an unescaped blank, a newline, or
 * an operator, at the start of a body, and after a `)` that closes a command; after `$(...)`, `$((...))`, `<(...)`, an
 * array assignment, an extended glob, a backtick body, an escaped character, or a continuation inside a word it is word
 * text, and the statement after it runs. Where a `)` may close a case pattern or a `!(` extended glob, Buckle cannot
 * place the `#`, so the call is unread. Rows where bash runs nothing on the line pin a real comment. Each shape ran
 * under real bash in scratch first.
 */
const COMMENTS: Shape[] = [
  ['after $()', `echo $(true)#; ${PAYLOAD}`],
  ['after a backtick body', `echo \`true\`#; ${PAYLOAD}`],
  ['after $(())', `echo $((1))#; ${PAYLOAD}`],
  ['after an escaped space', `echo x\\ #; ${PAYLOAD}`],
  ['after an escaped semicolon', `echo \\;#; ${PAYLOAD}`],
  ['after an escaped parenthesis', `echo \\(#; ${PAYLOAD}`],
  ['after an escaped ampersand', `echo \\&#; ${PAYLOAD}`],
  ['after an escaped pipe', `echo \\|#; ${PAYLOAD}`],
  ['after an escaped tab', `echo x\\\t#; ${PAYLOAD}`],
  ['after an escaped backtick', `echo \\\`#; ${PAYLOAD}`],
  ['after a carriage return', `echo x\r#; ${PAYLOAD}`],
  ['after a semicolon and a carriage return', `echo x;\r#; ${PAYLOAD}`],
  ['after a continuation inside a word', `echo x\\\n#; ${PAYLOAD}`],
  ['after <()', `cat <(true)#; ${PAYLOAD}`],
  ['after >()', `echo >(true)#; ${PAYLOAD}`],
  ['after an array assignment', `a=(1)#; ${PAYLOAD}`],
  ['after an array append', `a+=(1)#; ${PAYLOAD}`],
  ['after an extended glob', `shopt -s extglob\necho @(x)#; ${PAYLOAD}`],
  ['after nested $()', `echo $(echo $(true))#; ${PAYLOAD}`],
  ['after a subshell in $()', `echo $( (true) )#; ${PAYLOAD}`],
  ['after $(()) read as a subshell', `echo $((true))#; ${PAYLOAD}`],
  ['after $() in double quotes', `echo "$(true)"#; ${PAYLOAD}`],
  ['inside $(), after an escaped tab', `echo $(echo x\\\t#; ${PAYLOAD})`],
  ['inside $(), after a continuation inside a word', `echo $(echo x\\\n#; ${PAYLOAD})`],
  ['inside a backtick body, after an escaped space', `echo \`echo x\\ #; ${PAYLOAD}\``],
  ['inside a backtick body, after a nested body', `echo \`echo \\\`true\\\`#; ${PAYLOAD}\``],
  ['on a heredoc line in $(), after an escaped space', `cat <<EOF\n$(echo x\\ #; ${PAYLOAD})\nEOF`],
  ['in a quoted body fed to bash, after an escaped space', `bash <<'EOF'\necho x\\ #; ${PAYLOAD}\nEOF`],
  ['a real comment after a function definition, holding an apostrophe', `f()# don't\n{ ${PAYLOAD}; }; f`],
  ['a real comment after a subshell, holding an apostrophe', `(true)# don't\n${PAYLOAD}`],
  ['a real comment at the start of $()', `echo $(#c\n${PAYLOAD})`],
  ['a real comment at the start of a subshell', `(#c\n${PAYLOAD})`],
  ['a real comment at the start of a backtick body', `echo \`#c\`; ${PAYLOAD}`],
  ['a real comment after a subshell', `(true)#; ${PAYLOAD}`],
  ['a real comment after (( ))', `((1))#; ${PAYLOAD}`],
  ['a real comment after a semicolon', `true;#; ${PAYLOAD}`],
  ['a real comment after an ampersand', `true&#; ${PAYLOAD}`],
  ['a real comment after a redirection', `echo x >#; ${PAYLOAD}`],
  ['a real comment after a blank and a continuation', `echo x \\\n#; ${PAYLOAD}`],
  ['a real comment after an escaped backslash and a space', `echo x\\\\ #; ${PAYLOAD}`],
].map(([label, body]) => ({ label: `comment: ${label}`, body: body! }))

/** A `)` a case pattern or a `!(` may close: Buckle cannot tell whether the `#` after it starts a comment, so the call is unread. */
const UNSURE_COMMENTS: Shape[] = [
  ['a case in $()', `echo $(case x in x) :;; esac)#; ${PAYLOAD}`],
  ['a case in $() with an opening parenthesis', `echo $(case x in (x) :;; esac)#; ${PAYLOAD}`],
  ['a case pattern', `case x in x)#c\n${PAYLOAD};; esac`],
  ['a case word in an argument', `echo $(echo case)#; ${PAYLOAD}`],
  ['!( with extglob on', `shopt -s extglob\necho !(x)#; ${PAYLOAD}`],
  ['!( with extglob off', `!(true)#; ${PAYLOAD}`],
].map(([label, body]) => ({ label: `comment unsure: ${label}`, body: body!, unread: 'comment' as const }))

/**
 * Slice 7l: bash splits words only on space, tab, and newline, so a carriage return, vertical tab, form feed, no-break
 * space, or other Unicode space inside a wrapper's option value is word text, and the command after the value runs.
 */
const BLANK_SHAPES: Shape[] = [
  ['a carriage return in env -u', `env -u A\rB ${PAYLOAD}`],
  ['a carriage return in exec -a', `exec -a a\rb ${PAYLOAD}`],
  ['a vertical tab in exec -a', `exec -a a\vb ${PAYLOAD}`],
  ['a vertical tab in env -u', `env -u A\vB ${PAYLOAD}`],
  ['a form feed in env -u', `env -u A\fB ${PAYLOAD}`],
  ['a no-break space in exec -a', `exec -a a\u00a0b ${PAYLOAD}`],
  ['a no-break space in env -u', `env -u A\u00a0B ${PAYLOAD}`],
  ['an em space in env -u', `env -u A\u2003B ${PAYLOAD}`],
  ['a line separator in env -u', `env -u A\u2028B ${PAYLOAD}`],
  ['a carriage return in xargs -E', `xargs -E a\rb ${PAYLOAD} </dev/null`],
  ['a carriage return in a flock file name', `flock lock\rfile ${PAYLOAD}`],
  ['a carriage return in nested wrappers', `nice env -u A\rB nohup ${PAYLOAD}`],
  ['a carriage return ending the statement', `${PAYLOAD}\r`],
  ['a carriage return in a heredoc delimiter', `cat <<EOF\r\nx\r\nEOF\r\n${PAYLOAD}`],
].map(([label, body]) => ({ label: `blank: ${label}`, body: body! }))

function shapeBody(command: string, delimiter: { open: string; dash: boolean }, lines: string[], eol = '\n'): string {
  const tab = delimiter.dash ? '\t' : ''
  const redirect = delimiter.dash ? '<<-' : '<<'
  const indented = lines.map(line => tab + line).join(eol)
  return `${command} ${redirect}${delimiter.open}${eol}${indented}${eol}${tab}EOF`
}

/**
 * Slice 7l, the 7h to 7k review's surviving mutations: every hand-written row and shapeBody wrote `<<EOF` with no blank
 * and an exact delimiter line, so a reader that stopped skipping the blank after `<<` (X1), trimmed the delimiter line
 * before comparing it (X2), or stripped tabs from it under plain `<<` (X3) passed every test, and so did one that
 * dropped `until` from the shell keywords (X15). These rows, under every delimiter kind and both commands, fail each
 * of those readers: a blank after `<<` and `<<-`, and a delimiter line with trailing blanks or a tab under plain `<<`
 * that bash reads as body text, each before a body only a heredoc reading reads right (a single-quoted substitution on
 * a find line, which an unquoted body expands, and two backslashes before a newline, which an unquoted body fed to
 * bash halves into a continuation), and `until` around the payload. No other line carries the sentinel, so a reading
 * that left the body for shell text cannot meet the invocation elsewhere. Each ran under real bash in scratch first.
 */
function delimiterShapes(): Shape[] {
  const shapes: Shape[] = []
  const bodies = { 'a find line': [FIND_SINGLE_QUOTED], 'a halved continuation': [`${SENTINEL} \\\\`, 'mark'] }
  for (const command of COMMANDS) {
    for (const delimiter of DELIMITERS) {
      const kind = `${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`
      for (const [name, lines] of Object.entries(bodies)) {
        const spaced = shapeBody(command, delimiter, lines).replace(/<<(-?)/, '<< $1').replace('<< -', '<<- ')
        shapes.push({ label: `delimiter: a blank after the operator, ${name}, ${command} ${kind}`, body: spaced })
        shapes.push({ label: `delimiter: a line with trailing blanks is body text, ${name}, ${command} ${kind}`, body: shapeBody(command, delimiter, ['x', 'EOF  ', ...lines]) })
        if (!delimiter.dash) shapes.push({ label: `delimiter: a tab-indented line under plain << is body text, ${name}, ${command} ${kind}`, body: shapeBody(command, delimiter, ['x', '\tEOF', ...lines]) })
      }
    }
  }
  return shapes
}

/**
 * A command word whose value the shell supplies, from a variable, a substitution, a pattern, or a brace expansion, from
 * find's `{}`, or from what xargs hands on, names a command Buckle cannot know, so the call is unread (expansion): at the
 * start of a statement, behind each wrapper, after assignments, keywords, and redirections, inside a word, in a body fed
 * to bash, in a substitution in heredoc text, in a -c string, and in a `((` bash reads as a subshell. The patterns match
 * the sentinel the oracle's working directory holds. Each ran the sentinel under real bash in scratch first.
 */
const EXPANDED_COMMAND_WORDS: Shape[] = [
  ['a variable', `x=${SENTINEL}; $x mark`],
  ['a double-quoted variable', `x=${SENTINEL}; "$x" mark`],
  ['a braced variable', `x=${SENTINEL}; \${x} mark`],
  ['a substitution', `$(echo ${SENTINEL}) mark`],
  ['a backtick substitution', `\`echo ${SENTINEL}\` mark`],
  ['a double-quoted substitution', `"$(echo ${SENTINEL})" mark`],
  ['an array', `cmd=(${PAYLOAD}); "\${cmd[@]}"`],
  ['a brace expansion', `{${SENTINEL},mark}`],
  ['a bracket pattern', 's[e]ntinel mark'],
  ['a ? pattern', 'sentine? mark'],
  ['a path pattern', './sentine? mark'],
  ['a bracket path pattern', './s[e]ntinel mark'],
  ['an extended glob @()', `shopt -s extglob\n@(${SENTINEL}) mark`],
  ['an extended glob +()', `shopt -s extglob\n+(${SENTINEL}) mark`],
  ['an extended glob ?()', `shopt -s extglob\n?(${SENTINEL}) mark`],
  ['a substitution inside the word', 'sentin$(echo el) mark'],
  ['a backtick substitution inside the word', 'sentin`echo el` mark'],
  ['a substitution after an assignment holding blanks', `x=$(echo a b) $(echo ${SENTINEL}) mark`],
  ['a substitution after a double-quoted assignment holding quotes', `x="$(echo "a b")" $(echo ${SENTINEL}) mark`],
  ['a variable after a double-quoted assignment holding quotes', `y=${SENTINEL}; x="$(echo "a b")" $y mark`],
  ['a variable after an assignment', `x=${SENTINEL}; A=1 $x mark`],
  ['a variable after a redirection', `x=${SENTINEL}; 2>/dev/null $x mark`],
  ['a variable under if', `x=${SENTINEL}; if $x mark; then :; fi`],
  ['a variable under !', `x=${SENTINEL}; ! $x mark`],
  ['a variable behind sudo', `x=${SENTINEL}; sudo $x mark`],
  ['a variable behind doas', `x=${SENTINEL}; doas $x mark`],
  ['a variable behind env', `x=${SENTINEL}; env $x mark`],
  ['a double-quoted variable behind env and an assignment', `x=${SENTINEL}; env X=1 "$x" mark`],
  ['a variable behind timeout', `x=${SENTINEL}; timeout 5 $x mark`],
  ['a variable behind nice -n', `x=${SENTINEL}; nice -n 5 $x mark`],
  ['a variable behind command', `x=${SENTINEL}; command $x mark`],
  ['a variable behind exec', `x=${SENTINEL}; exec $x mark`],
  ['a substitution behind sudo', `sudo $(echo ${SENTINEL}) mark`],
  ['a backtick substitution behind env', `env \`echo ${SENTINEL}\` mark`],
  ['a variable behind xargs', `x=${SENTINEL}; echo a | xargs $x mark`],
  ['the xargs -I string behind env', `echo ${SENTINEL} | xargs -I X env X mark`],
  ['the xargs -I{} string behind sudo', `echo ${SENTINEL} | xargs -I{} sudo {} mark`],
  ['the xargs -i string behind env', `echo ${SENTINEL} | xargs -i env {} mark`],
  ['the xargs --replace string behind env', `echo ${SENTINEL} | xargs --replace env {} mark`],
  ['xargs items handed to env', `echo ${PAYLOAD} | xargs env`],
  ['xargs items handed to nice', `echo ${PAYLOAD} | xargs nice`],
  ['xargs items handed to xargs', `echo ${PAYLOAD} | xargs xargs`],
  ['find {} as the command word', `find . -maxdepth 1 -name ${SENTINEL} -exec {} mark \\;`],
  ['find -execdir {} as the command word', `find . -maxdepth 1 -name ${SENTINEL} -execdir {} mark \\;`],
  ['find {} behind env', `find . -maxdepth 1 -name ${SENTINEL} -exec env {} mark \\;`],
  ['find {} behind sudo', `find . -maxdepth 1 -name ${SENTINEL} -exec sudo {} mark \\;`],
  ['a variable in a quoted body fed to bash', `bash <<'EOF'\nx=${SENTINEL}; $x mark\nEOF`],
  ['an exported variable in a quoted body fed to bash', `export PYTHON=${SENTINEL}; bash <<'EOF'\n"$PYTHON" mark\nEOF`],
  ['a variable in a substitution in heredoc text', `x=${SENTINEL}; cat <<EOF\n$($x mark)\nEOF`],
  ['a variable in a substitution in double quotes', `x=${SENTINEL}; echo "$($x mark)"`],
  ['an exported variable in a -c string', `export x=${SENTINEL}; bash -c '$x mark'`],
  ['a variable in a (( bash reads as a subshell', `x=${SENTINEL}; (($x mark); true)`],
  ['a variable in a $(( bash reads as a substitution', `x=${SENTINEL}; echo $(($x mark) )`],
  ['a variable in a substitution in an array', `x=${SENTINEL}; a=($($x mark))`],
].map(([label, body]) => ({ label: `expanded command word: ${label}`, body: body!, unread: 'expansion' as const }))

/**
 * A command word the text spells, quoted, escaped, behind a tilde or a literal path, or after assignments that expand,
 * is read as written, and so are an argument, an array element, and arithmetic an expansion supplies: each call stays
 * read whole. A Makefile and a script written through `cat` hold lines that start with an expansion; the body is data
 * to cat, read as shell text only as a safety net, so it stays read too. Each ran under real bash in scratch first.
 */
const LITERAL_COMMAND_WORDS: Shape[] = [
  ...[
    ['a quoted letter', 's"e"ntinel mark'],
    ['an escaped first letter', `\\${PAYLOAD}`],
    ['single quotes', `'${SENTINEL}' mark`],
    ['double quotes', `"${SENTINEL}" mark`],
    ['ANSI-C quotes', `$'${SENTINEL}' mark`],
    ['a tilde path', `HOME="$PWD"; ~/${PAYLOAD}`],
    ['a literal path', `./${PAYLOAD}`],
    ['an assignment holding a variable', `A=$HOME ${PAYLOAD}`],
    ['an assignment holding a substitution with blanks', `x=$(echo a b) ${PAYLOAD}`],
    ['an assignment holding a double-quoted substitution', `A="$(echo x)" ${PAYLOAD}`],
    ['arithmetic holding a variable', `x=1; echo $(($x + 1)); ${PAYLOAD}`],
    ['arithmetic in double quotes holding a variable', `echo "$(( $# - 1 ))"; ${PAYLOAD}`],
    ['an arithmetic command holding a variable', `x=1; (( $x > 0 )) && ${PAYLOAD}`],
    ['an arithmetic for loop', `for ((i=0; i<1; i++)); do ${PAYLOAD}; done`],
    ['an array holding a variable', `x=1; a=($x y); ${PAYLOAD}`],
    ['an argument after a substitution', `x=1; echo $(echo a)$x b; ${PAYLOAD}`],
    ['a quoted string spanning lines of a body fed to bash', `bash <<'EOF'\necho "usage:\n  $0 [options]\n"\n${PAYLOAD}\nEOF`],
    ['a Makefile written through cat', `cat > Makefile <<'EOF'\nall:\n\t$(CC) -o x x.c\n\t"$PYTHON" -m pip install x\n\t${PAYLOAD}\nEOF`],
    ['a Makefile written through cat, unquoted', `cat > Makefile <<EOF\nall:\n\t\\$(CC) -o x x.c\n\t"\\$PYTHON" -m pip install x\n\t${PAYLOAD}\nEOF`],
    ['a script written through cat', `cat > run.sh <<'EOF'\n#!/bin/sh\n"$PYTHON" -m pytest\n$(dirname "$0")/build.sh\n\${RUNNER:-sh} x\n${PAYLOAD}\nEOF`],
    ['a script written through tee', `tee run.sh >/dev/null <<'EOF'\n"$PYTHON" -m pytest\n${PAYLOAD}\nEOF`],
    ['a script written through cat beside a body fed to bash', `cat > run.sh <<'EOF'\n"$PYTHON" -m pytest\nEOF\nbash <<'EOF'\n${PAYLOAD}\nEOF`],
  ].map(([label, body]) => ({ label: `literal command word: ${label}`, body: body!, whole: true as const })),
  { label: 'literal command word: an argument a variable supplies (read as written)', body: `x=mark; ${SENTINEL} $x`, written: '$x', whole: true },
  { label: 'literal command word: a separator and a variable inside a quoted argument (read as written)', body: `${SENTINEL} "fix; $x mark"`, written: 'fix; $x mark', whole: true },
]

/** Links in the oracle's working directory to the shell's own input and to descriptor 3, as a script operand may be. */
const TO_INPUT = 'ln -sfn /dev/stdin in0'
const TO_FD3 = 'ln -sfn /dev/fd/3 in3'

/**
 * A shell or `source` given a script operand while the call's own text feeds its input, on any descriptor, by a pipe,
 * a heredoc, a here-string, or a process substitution, on the command or on a pipeline or compound command around it,
 * may read its script from that input: the operand may be a link to it or a device path Buckle cannot resolve. The call
 * is unread (script as data). Each ran the sentinel under real bash in scratch first, sudo and ssh as their stand-ins.
 */
const FED_SCRIPT_OPERANDS: Shape[] = [
  ['a pipe into bash "$x"', `x=/dev/stdin; echo '${PAYLOAD}' | bash "$x"`],
  ['a pipe into source "$x"', `x=/dev/stdin; echo '${PAYLOAD}' | source "$x"`],
  ['a pipe into . "$x"', `x=/dev/stdin; echo '${PAYLOAD}' | . "$x"`],
  ['a heredoc into source "$x"', `x=/dev/stdin; source "$x" <<'EOF'\n${PAYLOAD}\nEOF`],
  ['a here-string into bash "$x"', `x=/dev/stdin; bash "$x" <<< '${PAYLOAD}'`],
  ['a pipe into bash stdin from /dev', `cd /dev; echo '${PAYLOAD}' | bash stdin`],
  ['a pipe into bash through a link', `${TO_INPUT}; echo '${PAYLOAD}' | bash in0`],
  ['a heredoc into bash through a link', `${TO_INPUT}; bash in0 <<'EOF'\n${PAYLOAD}\nEOF`],
  ['a here-string into bash through a link', `${TO_INPUT}; bash in0 <<< '${PAYLOAD}'`],
  ['a process substitution into bash through a link', `${TO_INPUT}; bash in0 < <(echo '${PAYLOAD}')`],
  ['a here-string on descriptor 3 into bash through a link', `${TO_FD3}; bash in3 3<<< '${PAYLOAD}'`],
  ['a heredoc on descriptor 3 into bash through a link', `${TO_FD3}; bash in3 3<<'EOF'\n${PAYLOAD}\nEOF`],
  ['a pipe into a group', `${TO_INPUT}; echo '${PAYLOAD}' | { true; bash in0; }`],
  ['a pipe into a subshell', `${TO_INPUT}; echo '${PAYLOAD}' | (true; bash in0)`],
  ['a pipe into if', `${TO_INPUT}; echo '${PAYLOAD}' | if true; then bash in0; fi`],
  ['a pipe into while', `${TO_INPUT}; echo '${PAYLOAD}' | while true; do bash in0; break; done`],
  ['a pipe into for', `${TO_INPUT}; echo '${PAYLOAD}' | for i in 1; do bash in0; done`],
  ['a pipe into case', `${TO_INPUT}; echo '${PAYLOAD}' | case x in x) bash in0;; esac`],
  ['a heredoc on a group', `${TO_INPUT}; { bash in0; } <<'EOF'\n${PAYLOAD}\nEOF`],
  ['a here-string on a subshell', `${TO_INPUT}; (bash in0) <<< '${PAYLOAD}'`],
  ['a heredoc on a while loop', `${TO_INPUT}; while true; do bash in0; break; done <<'EOF'\n${PAYLOAD}\nEOF`],
  ['a process substitution on if', `${TO_INPUT}; if true; then bash in0; fi < <(echo '${PAYLOAD}')`],
  ['exec redirecting the input to a heredoc', `${TO_INPUT}; exec <<'EOF'\n${PAYLOAD}\nEOF\nbash in0`],
  ['exec redirecting descriptor 3 to a here-string', `${TO_FD3}; exec 3<<< '${PAYLOAD}'; bash in3`],
  ['a function called in a pipeline', `${TO_INPUT}; f() { bash in0; }; echo '${PAYLOAD}' | f`],
  ['a function keyword called with a here-string', `${TO_INPUT}; function f { bash in0; }; f <<< '${PAYLOAD}'`],
  ['a pipe into sudo bash', `${TO_INPUT}; echo '${PAYLOAD}' | sudo bash in0`],
  ['a pipe into env bash', `${TO_INPUT}; echo '${PAYLOAD}' | env bash in0`],
  ['a pipe into bash -c', `${TO_INPUT}; echo '${PAYLOAD}' | bash -c 'bash in0'`],
  ['a pipe into eval', `${TO_INPUT}; echo '${PAYLOAD}' | eval 'bash in0'`],
  ['a pipe into ssh', `${TO_INPUT}; echo '${PAYLOAD}' | ssh host 'bash in0'`],
  ['a pipe into find -exec', `${TO_INPUT}; echo '${PAYLOAD}' | find . -maxdepth 0 -exec bash in0 \\;`],
  ['a |& pipe into bash', `${TO_INPUT}; echo '${PAYLOAD}' |& bash in0`],
  ['a second pipe into bash', `${TO_INPUT}; echo '${PAYLOAD}' | cat | bash in0`],
  ['a pipe into a substitution', `${TO_INPUT}; echo '${PAYLOAD}' | cat $(bash in0)`],
  ['a pipe into bash cut by a substitution', `${TO_INPUT}; echo '${PAYLOAD}' | bash in0 "$(true)"`],
  ['bash of a process substitution of printf', `bash <(printf '${PAYLOAD}')`],
  ['source of a process substitution of printf', `source <(printf '${PAYLOAD}')`],
].map(([label, body]) => ({ label: `fed script operand: ${label}`, body: body!, unread: 'scriptData' as const }))

/**
 * With no feed from the call's own text, a script operand stays a script file, read as before: after a pipeline that
 * has ended, beside `||`, before a pipe, from a file, and inside a body fed to a shell, whose input is that body,
 * which Buckle reads. A here-string feeds only its own command, not a substitution in it, and opens no heredoc, so the
 * line after it is a command. Each ran under real bash in scratch first.
 */
const UNFED_SCRIPT_OPERANDS: Shape[] = [
  ...[
    ['source "$NVM_DIR/nvm.sh"', `source "$NVM_DIR/nvm.sh"; ${PAYLOAD}`],
    ['. "$HOME/.cargo/env"', `HOME="$PWD"; mkdir -p .cargo; : > .cargo/env; . "$HOME/.cargo/env"; ${PAYLOAD}`],
    ['bash "$script"', `printf 'true\\n' > s.sh; script=./s.sh; bash "$script"; ${PAYLOAD}`],
    ['bash script.sh < file', `printf 'true\\n' > s.sh; : > input; bash s.sh < input; ${PAYLOAD}`],
    ['source before a pipeline', `printf 'true\\n' > activate; source ./activate && echo x | cat; ${PAYLOAD}`],
    ['bash after a pipeline ended', `printf 'true\\n' > s.sh; echo x | cat; bash s.sh; ${PAYLOAD}`],
    ['bash after ||', `printf 'true\\n' > s.sh; false || bash s.sh; ${PAYLOAD}`],
    ['bash before a pipe', `printf 'true\\n' > s.sh; bash s.sh 2>&1 | cat; ${PAYLOAD}`],
    ['bash after a piped group closed', `printf 'true\\n' > s.sh; echo x | { cat; }; bash s.sh; ${PAYLOAD}`],
    ['bash after a piped loop closed', `printf 'true\\n' > s.sh; echo x | while read -r l; do :; done; bash s.sh; ${PAYLOAD}`],
    ['bash /dev/stdin fed its heredoc', `bash /dev/stdin <<'EOF'\n${PAYLOAD}\nEOF`],
    ['source in a body fed to bash', `printf 'true\\n' > s.sh; bash <<'EOF'\nsource ./s.sh\n${PAYLOAD}\nEOF`],
    ['a script written through cat', `cat > setup.sh <<'EOF'\necho x | bash ./build.sh\nsource ~/.profile\n${PAYLOAD}\nEOF`],
    ['a here-string on a command holding a substitution', `${TO_INPUT}; cat $(bash in0) <<< x; ${PAYLOAD}`],
    ['a here-string before a substitution in its command', `${TO_INPUT}; cat <<< x $(bash in0); ${PAYLOAD}`],
    ['a heredoc whose <<- is apart from its delimiter', `printf 'true\\n' > s.sh; bash <<- EOF\n\tbash s.sh\n\t${PAYLOAD}\n\tEOF`],
  ].map(([label, body]) => ({ label: `unfed script operand: ${label}`, body: body!, whole: true as const })),
  { label: 'unfed script operand: the line after a here-string is a command', body: `cat <<< x\nx=${SENTINEL}; $x mark`, unread: 'expansion' },
]

/**
 * busybox and toybox run the applet their first operand names, so the command behind one is read as that applet with
 * its words; a shell applet stays an interpreter Buckle does not read as bash. Neither is installed here, so these rows
 * skip where the program is absent, as the other absent shells do. chrt from util-linux 2.41 runs a command given with
 * no priority; an older chrt refuses it and runs nothing, so here the rows are over-reads, which the reading allows.
 */
const MULTICALL_AND_CHRT: Shape[] = [
  ...['busybox', 'toybox'].flatMap(binary => [
    { label: `${binary}: env`, body: `${binary} env ${PAYLOAD}`, needs: binary },
    { label: `${binary}: env -u`, body: `${binary} env -u HOME ${PAYLOAD}`, needs: binary },
    { label: `${binary}: nice`, body: `${binary} nice ${PAYLOAD}`, needs: binary },
    { label: `${binary}: timeout`, body: `${binary} timeout 5 ${PAYLOAD}`, needs: binary },
    { label: `${binary}: xargs`, body: `echo mark | ${binary} xargs ${SENTINEL}`, needs: binary },
  ]),
  { label: 'toybox: sh -c is an interpreter', body: `toybox sh -c '${PAYLOAD}'`, unread: 'interpreter', needs: 'toybox' },
  { label: 'chrt: a policy with no priority', body: `chrt -o ${PAYLOAD}`, whole: true },
  { label: 'chrt: a long policy with no priority', body: `chrt --other ${PAYLOAD}`, whole: true },
  { label: 'chrt: no policy and no priority', body: `chrt ${PAYLOAD}`, whole: true },
]

/**
 * Shell text a builtin keeps for the shell to run later: a trap's action, run on a signal or at exit; an alias's value,
 * run where its name begins a command (with expand_aliases, on a later line), the words after the name joined on; and a
 * mapfile or readarray callback, run every quantum of lines with the index and the line as words. Each is read as shell
 * text, and is unread (expansion) where an expansion supplies it. Arithmetic evaluates a variable's text, running a
 * substitution in an array subscript; Buckle reads such text where the call spells it, through the statement pieces,
 * and these rows pin that. Each ran the sentinel under real bash in scratch first.
 */
const HELD_TEXT: Shape[] = [
  ...[
    ['a trap on exit', `trap '${PAYLOAD}' EXIT`],
    ['a trap after --', `trap -- '${PAYLOAD}' EXIT`],
    ['a trap on ERR', `trap '${PAYLOAD}' ERR; false`],
    ['a trap on two signals', `trap '${PAYLOAD}' INT TERM; kill -INT $$`],
    ['an alias', `shopt -s expand_aliases\nalias x='${PAYLOAD}'\nx`],
    ['an alias the words after its name join', `shopt -s expand_aliases\nalias x=${SENTINEL}\nx mark`],
    ['an alias of an alias', `shopt -s expand_aliases\nalias g='${SENTINEL}' f='g mark'\nf`],
    ['an alias ending in a blank', `shopt -s expand_aliases\nalias e='env '\ne ${PAYLOAD}`],
    ['a mapfile callback', `mapfile -C '${PAYLOAD} #' -c 1 <<< a`],
    ['a readarray callback', `readarray -C '${PAYLOAD} #' -c 1 <<< a`],
    ['an attached mapfile callback', `mapfile -C'${PAYLOAD} #' -c1 <<< a`],
    ['a mapfile callback after -t', `mapfile -t -C '${PAYLOAD} #' -c 1 lines <<< a`],
    ['arithmetic of a variable', `x='a[$(${PAYLOAD})]'; (( x ))`],
    ['arithmetic expansion of a variable', `x='a[$(${PAYLOAD})]'; y=$(( x + 1 ))`],
    ['let of a variable', `x='a[$(${PAYLOAD})]'; let x`],
    ['an integer declaration of a variable', `x='a[$(${PAYLOAD})]'; declare -i y=x`],
    ['an arithmetic test of a variable', `x='a[$(${PAYLOAD})]'; [[ x -eq 0 ]]`],
  ].map(([label, body]) => ({ label: `held text: ${label}`, body: body! })),
  ...[
    ['a trap of a variable', `x='${PAYLOAD}'; trap "$x" EXIT`],
    ['a trap whose command word is a variable', `trap 'x=${SENTINEL}; $x mark' EXIT`],
    ['an alias of a variable', `shopt -s expand_aliases\na='${PAYLOAD}'; alias x="$a"\nx`],
    ['a mapfile callback of a variable', `x='${PAYLOAD} #'; mapfile -C "$x" -c 1 <<< a`],
    ['a trap holding a variable after its command word', `x='mark; ${SENTINEL} two'; trap "${SENTINEL} $x" EXIT`],
    ['an alias holding a variable after its command word', `x='mark; ${SENTINEL} two'; shopt -s expand_aliases\nalias y="${SENTINEL} $x"\ny`],
    ['a mapfile callback holding a variable after its command word', `x='mark; ${SENTINEL} two #'; mapfile -C "${SENTINEL} $x" -c 1 <<< a`],
  ].map(([label, body]) => ({ label: `held text: ${label}`, body: body!, unread: 'expansion' as const })),
]

/**
 * Quotes nest as bash nests them: inside double quotes, and outside, a `$(...)` body, a `${...}` parameter expansion, and
 * a backtick body each start a fresh quoting context, so a word holding one ends where bash ends it. Each word below
 * holds quotes, a separator, a blank, a comment, a heredoc body, or a case pattern that a reading ignoring the nesting
 * ends the word at, and stands as an assignment before the sentinel, as an argument before a later statement, behind
 * env and sudo, and, spelled to name the sentinel, as the command word itself, which an expansion supplies, so the call
 * is unread. Each ran the sentinel under real bash in scratch first.
 */
const NESTED_WORDS: Array<readonly [string, string, string | null]> = [
  ['a substitution holding a double-quoted string', '"$(echo "a b")"', `"$(echo "${SENTINEL}")"`],
  ['a default value holding a double-quoted string', '"${q:-"a b"}"', `"\${q:-"${SENTINEL}"}"`],
  ['a default value holding a quoted separator', '"${q:-"a;b"}"', `"\${q:-"${SENTINEL}"}"`],
  ['an unquoted default value holding a blank', '${q:-a b}', `\${q:-${SENTINEL}}`],
  ['an unquoted default value holding a separator', '${q:-a;b}', `\${q:-${SENTINEL}}`],
  ['a default value holding a single-quoted brace', `"\${q:-'}'}"`, null],
  ['an unquoted default value holding a single-quoted brace and a separator', `\${q:-'}; a'}`, null],
  ['an unquoted default value holding a single-quoted brace and a double quote', `\${q:-'}"'}`, null],
  ['a default value holding a substitution with blanks', '${q:-$(echo a b)}', `\${q:-$(echo ${SENTINEL})}`],
  ['a substitution two deep, each double-quoted', '"$(echo "$(echo "c d")")"', `"$(echo "$(echo "${SENTINEL}")")"`],
  ['a substitution holding a double-quoted parenthesis', '"$(echo ")")"', `"$(echo ")" >/dev/null; echo ${SENTINEL})"`],
  ['a substitution holding a single-quoted parenthesis', `"$(echo ')')"`, `"$(echo ')' >/dev/null; echo ${SENTINEL})"`],
  ['a substitution holding a case pattern', '"$(case a in a) echo "q; r";; esac)"', `"$(case a in a) echo "${SENTINEL}";; esac)"`],
  ['a substitution holding a separator after a parenthesized case pattern and an alternative', '"$(case a in (a) :;; b|c) echo "q; r";; esac)"', `"$(case b in (a) :;; b|c) echo "${SENTINEL}";; esac)"`],
  ['a substitution holding a separator after a second case pattern', '"$(case a in a) :;; b) echo "q; r";; esac)"', `"$(case b in a) :;; b) echo "${SENTINEL}";; esac)"`],
  ['a substitution holding a case whose in is on the next line', '"$(case a\nin a) echo "q; r";; esac)"', `"$(case a\nin a) echo "${SENTINEL}";; esac)"`],
  ['a substitution holding a command after a case', '"$(case a in a) :;; esac; echo "q; r")"', `"$(case a in a) :;; esac; echo "${SENTINEL}")"`],
  ['a backtick body holding escaped double quotes', '"`echo \\"a b\\"`"', `"\`echo \\"${SENTINEL}\\"\`"`],
  ['arithmetic holding double quotes', '"$(( "1" + (2) ))"', null],
  ['a substitution holding a heredoc body with a parenthesis', '"$(cat <<EOF\n) "\nEOF\n)"', `"$(cat <<EOF\n${SENTINEL}\nEOF\n)"`],
  ['a substitution holding a comment with a parenthesis', '"$(echo a # ) "\n)"', `"$(echo ${SENTINEL} # ) "\n)"`],
]

/** The sentinel with an argument holding a quoted separator, which no statement piece reads whole, so only a statement split as bash splits it meets the invocation. */
const QUOTED_PAYLOAD = `${SENTINEL} "c;d"`

const QUOTE_NESTING: Shape[] = NESTED_WORDS.flatMap(([name, word, command]) => [
  { label: `quote nesting: ${name}, an assignment before a command`, body: `x=${word} ${QUOTED_PAYLOAD}`, whole: true as const },
  { label: `quote nesting: ${name}, an argument before a later statement`, body: `echo ${word}; ${QUOTED_PAYLOAD}`, whole: true as const },
  { label: `quote nesting: ${name}, behind env`, body: `env X=${word} ${QUOTED_PAYLOAD}`, whole: true as const },
  { label: `quote nesting: ${name}, behind sudo`, body: `sudo X=${word} ${QUOTED_PAYLOAD}`, whole: true as const },
  ...(command === null ? [] : [{ label: `quote nesting: ${name}, the command word`, body: `${command} mark`, unread: 'expansion' as const }]),
])

/**
 * A shell runs a startup file before its script: BASH_ENV in a non-interactive bash, ENV in an interactive sh or bash in
 * POSIX mode, and bash's --rcfile or --init-file when interactive, each name expanded first, command substitution
 * included. Where the call supplies that file's text (a process substitution, the shell's own input, another
 * descriptor, a command substitution in the name, or a name an expansion supplies while the call feeds the shell), set
 * before the command, through env, or exported earlier, the call is unread (script as data). A file on disk, /dev/null,
 * a shell with none, and a heredoc on the shell's own input stay read. Each ran the sentinel, or nothing where noted,
 * under real bash and dash in scratch first.
 */
const STARTUP_FILES: Shape[] = [
  ...[
    ['BASH_ENV of a process substitution', `BASH_ENV=<(echo ${PAYLOAD}) bash -c true`],
    ['BASH_ENV of a process substitution through env', `env BASH_ENV=<(echo ${PAYLOAD}) bash -c true`],
    ['BASH_ENV of a process substitution before env', `BASH_ENV=<(echo ${PAYLOAD}) env bash -c true`],
    ['BASH_ENV of a process substitution for a script', `printf 'true\\n' > s.sh; BASH_ENV=<(echo ${PAYLOAD}) bash s.sh`],
    ['BASH_ENV of a process substitution for a nested shell', `BASH_ENV=<(echo ${PAYLOAD}) bash -c 'bash -c true'`],
    ['BASH_ENV of a process substitution for a function that starts a shell', `f() { bash -c true; }; BASH_ENV=<(echo ${PAYLOAD}) f`],
    ['BASH_ENV of /dev/stdin from a here-string', `BASH_ENV=/dev/stdin bash -c true <<< '${PAYLOAD}'`],
    ['BASH_ENV of /dev/stdin from a pipe', `echo '${PAYLOAD}' | BASH_ENV=/dev/stdin bash -c true`],
    ['BASH_ENV of a descriptor', `BASH_ENV=/dev/fd/3 bash -c true 3<<< '${PAYLOAD}'`],
    ['BASH_ENV of a variable naming /dev/stdin, fed by a pipe', `x=/dev/stdin; echo '${PAYLOAD}' | BASH_ENV="$x" bash -c true`],
    ['BASH_ENV holding a command substitution', `BASH_ENV='$(${PAYLOAD})' bash -c true`],
    ['BASH_ENV holding a backtick substitution', `BASH_ENV='\`${PAYLOAD}\`' bash -c true`],
    ['BASH_ENV holding a command substitution through env', `env BASH_ENV='$(${PAYLOAD})' bash -c true`],
    ['BASH_ENV of /dev/stdin exported, then a pipe into bash', `export BASH_ENV=/dev/stdin; echo '${PAYLOAD}' | bash -c true`],
    ['BASH_ENV of a descriptor exported apart', `BASH_ENV=/dev/fd/3; export BASH_ENV; exec 3<<< '${PAYLOAD}'; bash -c true`],
    ['BASH_ENV of a variable exported, then a pipe into bash', `x=/dev/stdin; export BASH_ENV=$x; echo '${PAYLOAD}' | bash -c true`],
    ['BASH_ENV of /dev/stdin declared exported', `declare -x BASH_ENV=/dev/stdin; bash -c true <<< '${PAYLOAD}'`],
    ['an exported BASH_ENV of a process substitution (runs nothing: the descriptor closes first)', `export BASH_ENV=<(echo ${PAYLOAD}); bash -c true`],
    ['--rcfile of a process substitution', `bash --rcfile <(echo ${PAYLOAD}) -i -c true`],
    ['--init-file of a process substitution', `bash --init-file <(echo ${PAYLOAD}) -i -c true`],
    ['--rcfile of a descriptor', `bash --rcfile /dev/fd/3 -i -c true 3<<< '${PAYLOAD}'`],
    ['--init-file of /dev/stdin from a here-string', `bash --init-file /dev/stdin -i -c true <<< '${PAYLOAD}'`],
    ['ENV of a process substitution for an interactive sh', `ENV=<(echo ${PAYLOAD}) sh -i -c true`],
    ['ENV of a process substitution for bash --posix -i', `ENV=<(echo ${PAYLOAD}) bash --posix -i -c true`],
    ['ENV holding a command substitution for an interactive sh', `ENV='$(${PAYLOAD})' sh -i -c true`],
    ['ENV of a descriptor for an interactive sh', `ENV=/dev/fd/3 sh -i -c true 3<<< '${PAYLOAD}'`],
  ].map(([label, body]) => ({ label: `startup file: ${label}`, body: body!, unread: 'scriptData' as const })),
  ...[
    ['BASH_ENV of a file on disk', `BASH_ENV=/etc/profile bash -c true; ${PAYLOAD}`],
    ['BASH_ENV of a missing file a variable names', `BASH_ENV="$PWD/none" bash -c true; ${PAYLOAD}`],
    ['BASH_ENV of /dev/null', `BASH_ENV=/dev/null bash -c true; ${PAYLOAD}`],
    ['--rcfile of /dev/null', `bash --rcfile /dev/null -i -c true; ${PAYLOAD}`],
    ['a shell with no startup file', `bash -c true; ${PAYLOAD}`],
    ['BASH_ENV of /dev/stdin fed its heredoc', `BASH_ENV=/dev/stdin bash -c true <<'EOF'\n${PAYLOAD}\nEOF`],
  ].map(([label, body]) => ({ label: `startup file read: ${label}`, body: body!, whole: true as const })),
]

/**
 * bash expands an alias where its name is a command's word: past the reserved words before a command, so in a function's
 * body too, and in the word after an alias whose value ends in a blank; each such use in the same text is read with the
 * value in place of the name. In text the same shell parses later (eval, a trap's action, a mapfile callback, source of
 * its input) an alias defined anywhere in the call is expanded too, which no reading follows, so a call that defines one
 * and runs such text is unread (expansion). A child shell has no aliases, and sh (dash) expands them with no shopt.
 * Each ran the sentinel, or nothing where noted, under real bash and dash in scratch first.
 */
const ALIASED = `shopt -s expand_aliases\nalias x=${SENTINEL}\n`
const ALIAS_USES: Shape[] = [
  ...[
    ['after if', 'if x mark; then :; fi'],
    ['after then', 'if true; then x mark; fi'],
    ['in a group', '{ x mark; }'],
    ['after !', '! x mark'],
    ['after time', 'time x mark'],
    ['after time -p', 'time -p x mark'],
    ['after while', 'while x mark; do break; done'],
    ['after do', 'for i in 1; do x mark; done'],
    ['in a function body', 'f() { x mark; }\nf'],
    ['in a function keyword body', 'function g { x mark; }; g'],
    ['after coproc', 'coproc x mark; wait'],
    ['in a -c string, a child shell with no aliases (runs nothing)', "bash -c 'x mark'"],
    ['in a heredoc fed to bash, a child shell with no aliases (runs nothing)', "bash <<'EOF'\nx mark\nEOF"],
  ].map(([label, use]) => ({ label: `alias: ${label}`, body: `${ALIASED}${use}`, whole: true as const })),
  { label: 'alias: after an alias ending in a blank', body: `shopt -s expand_aliases\nalias e='env ' x=${SENTINEL}\ne x mark`, whole: true },
  { label: 'alias: sh expands one with no shopt', body: `sh -c 'alias x=${SENTINEL}\nx mark'`, whole: true },
  ...[
    ['eval', 'eval x mark'],
    ['eval behind command', 'command eval x mark'],
    ['eval after --', 'eval -- x mark'],
    ['a trap action', "trap 'x mark' EXIT"],
    ['a trap action after --', "trap -- 'x mark' EXIT"],
    ['a mapfile callback', "mapfile -C 'x mark #' -c 1 <<< a"],
    ['source of its input', "source /dev/stdin <<'EOF'\nx mark\nEOF"],
    ['a function eval defines', "eval 'f() { x mark; }'; f"],
  ].map(([label, use]) => ({ label: `alias in text parsed later: ${label}`, body: `${ALIASED}${use}`, unread: 'expansion' as const })),
  { label: 'alias in text parsed later: one eval defines, used after it', body: `shopt -s expand_aliases\neval "alias x=${SENTINEL}"\nx mark`, unread: 'expansion' },
  { label: 'alias in text parsed later: sh, eval', body: `sh -c 'alias x=${SENTINEL}\neval x mark'`, unread: 'expansion' },
  { label: 'alias in text parsed later: sh, a trap action', body: `sh -c 'alias x=${SENTINEL}\ntrap "x mark" EXIT'`, unread: 'expansion' },
]

/**
 * Arithmetic evaluates a variable's text, running a substitution in an array subscript, and `set -x` expands PS4 before
 * each command it traces. Buckle reads such text only where the call spells it out (its statement pieces), not where the
 * call builds it at run time: these rows pin that limit (bash ran the sentinel in each).
 */
const RUN_TIME_TEXT: Shape[] = [
  // HELD_TEXT holds the arithmetic row: `x='a[$(...)]'; (( x ))`.
  { label: 'run-time text: PS4 the call spells out is read', body: `PS4='$(${PAYLOAD})'; set -x; true` },
]

/** An `until` loop runs its condition, so the command in it runs as surely as one under `if` or `while`. */
const KEYWORD_SHAPES: Shape[] = [
  { label: 'keyword: until around the payload', body: `until ${PAYLOAD}; do :; done` },
  { label: 'keyword: until in a quoted body fed to bash', body: `bash <<'EOF'\nuntil ${PAYLOAD}; do :; done\nEOF` },
  { label: 'keyword: until under bash -c', body: `bash -c 'until ${PAYLOAD}; do :; done'` },
]

/** Every shape, each body once: a later table's copy of a body an earlier one holds is dropped, flags and all. */
function allShapes(): Shape[] {
  const shapes: Shape[] = []
  for (const command of COMMANDS) {
    for (const delimiter of DELIMITERS) {
      for (const [name, lines] of Object.entries({ ...PLACEMENTS, ...PROBE_PLACEMENTS })) {
        const kind = `${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`
        shapes.push({ label: `${command} ${kind} ${name}`, body: shapeBody(command, delimiter, lines) })
      }
    }
  }
  const all = [...shapes, ...NESTED, ...REVIEW_SHAPES, ...ADVERSARIAL, ...backtickShapes(), ...BACKTICK_EXTRA, ...backtickCommentShapes(), ...SCRIPT_DATA, ...continuationRunShapes(), ...INTERPRETERS, ...crlfShapes(), ...PROBE_CONSUMERS, ...PROBE_TOP_LEVEL, ...wrappedShapes(), ...SESSIONS, ...READING_PINS, ...COMMENTS, ...UNSURE_COMMENTS, ...BLANK_SHAPES, ...backtickContinuationShapes(), ...UNREAD_INPUTS, ...OTHER_SHELLS, ...OWN_PARSING, ...delimiterShapes(), ...KEYWORD_SHAPES, ...EXPANDED_COMMAND_WORDS, ...LITERAL_COMMAND_WORDS, ...FED_SCRIPT_OPERANDS, ...UNFED_SCRIPT_OPERANDS, ...MULTICALL_AND_CHRT, ...HELD_TEXT, ...QUOTE_NESTING, ...STARTUP_FILES, ...ALIAS_USES, ...RUN_TIME_TEXT]
  const seen = new Set<string>()
  return all.filter(shape => !seen.has(shape.body) && seen.add(shape.body))
}

/**
 * A sentinel invocation by its arguments, whitespace collapsed: a deny glob matches on the command and its argument
 * words, not on how tabs or spaces fall, and a `<<-` continuation leaves bash an argument a stray tab Buckle's
 * tab-stripped reading drops, which is no bypass. Comparing the normalised argument keeps the superset meaningful.
 */
const invocation = (args: string): string => args.replace(/\s+/g, ' ').trim()

/** The sentinel invocations Buckle read on the body: every command form whose name is the sentinel, by its arguments. */
function buckleRan(forms: CommandForms): Set<string> {
  const ran = new Set<string>()
  for (const form of allForms(forms)) if (baseCommand(form[0] ?? '') === SENTINEL) ran.add(invocation(form.slice(1).join(' ')))
  return ran
}

/** A word that assigns a variable before a command, which names no command. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

/**
 * The agreement check: each command word the whole-command reading judges (CommandForms `heads`, every command a
 * substitution cut, read whole) must be the command word of some form, the forms being what every rule matches on; one
 * no form reads is a command no deny glob and no floor meets (the forms read `x="$(echo "a b")" git push` as the command
 * `b)` while that reading, and bash, ran git push). An assignment step names no command, and a word holding a body
 * (`$()`) is one an expansion supplies, which leaves the call unread. The command words it leaves out, each once.
 */
function unreadByForms(forms: CommandForms): string[] {
  const read = new Set(allForms(forms).map(form => form[0]))
  const judged = new Set(forms.heads.map(head => head[0] ?? ''))
  return [...judged].filter(word => word !== '' && !ASSIGNMENT_WORD.test(word) && !word.includes('$()') && !read.has(word))
}

/**
 * The reader stays linear on adversarial bulk, needing no bash: a thousand heredocs nested one in another are left
 * unread at the depth limit, and a 1 MB body, 100,000 one-character lines and 50,000 continuations each read within a
 * second (slice 7g review coverage probes). Each limit is on the reader's own processor time, the least of three warm
 * readings with no process spawned (leastProcessorTime), so a loaded machine or a cold start does not fail it: here the
 * rows take about 30 to 220 ms of the 1000 ms allowed (slice 7l, the 7h to 7k review's flaky timing rows).
 */
describe('the reader is bounded on adversarial bulk', () => {
  const under = (body: string, limit = 1_000) => {
    const { milliseconds, result } = leastProcessorTime(() => commandForms('bash', ['-c', body]))
    expect(milliseconds).toBeLessThan(limit)
    return result
  }

  it('leaves a thousand nested heredocs unread at the depth limit, within a second', () => {
    const open = Array.from({ length: 1_000 }, (_, index) => `bash <<'D${index}'`).join('\n')
    const close = Array.from({ length: 1_000 }, (_, index) => `D${999 - index}`).join('\n')
    expect(under(`${open}\necho "$(${PAYLOAD})"\n${close}`).unread).toBe('depth')
  })

  it('reads a 1 MB adversarial body within a second', () => {
    const line = `find . -maxdepth 0 -exec true '$(${PAYLOAD})' \\;`
    const body = `cat <<EOF\n${Array.from({ length: Math.ceil(1_000_000 / line.length) }, () => line).join('\n')}\nEOF`
    expect(body.length).toBeGreaterThan(1_000_000)
    under(body)
  })

  it('reads 100,000 one-character body lines within a second', () => {
    under(`cat <<EOF\n${Array.from({ length: 100_000 }, () => 'x').join('\n')}\nEOF`)
  })

  it('reads 50,000 continuations within a second', () => {
    under(`bash <<EOF\n${Array.from({ length: 50_000 }, () => 'echo a \\').join('\n')}\ndone\nEOF`)
  })

  // Each `((` looks ahead for the `))` that makes it arithmetic; a megabyte of open parentheses stops at the read budget.
  it.each(['((', '$(('])('stops at the read budget within a second on a megabyte of %s never closed', (opener) => {
    expect(readLimitOf(under(opener.repeat(Math.ceil(1_000_000 / opener.length))))).toBe('budget')
  })

  /**
   * Slice 7l, the 7h to 7k review: a request under the 1 MiB cap of eight heredocs fed to bash, one in another, around
   * backtick bodies took 33.7 s to read, since each pass over a body re-read it whole. Every pass is now charged to
   * the read budget, so the reading stops as 'budget' (refused under any deny glob, asked at the floor). Here it takes
   * about 200 ms of the 1000 ms allowed; one level and four levels too.
   */
  it.each([1, 4, 8])('stops at the read budget within a second on the 1 MiB shape of %i heredocs fed to bash around backtick bodies', (levels) => {
    let body = `echo ${Array.from({ length: 200_000 }, (_, index) => `w${index % 1000}`).join(' ')} \\\\x`
    for (let level = 0; level < levels; level++) body = `bash <<E${level}\necho \`${body}\`\nE${level}\n`
    expect(JSON.stringify({ command: 'bash', args: ['-c', body] }).length).toBeLessThan(1_048_576)
    expect(readLimitOf(under(body))).toBe('budget')
  })
})

describe.skipIf(!hasBash)('heredoc and continuation shapes read a superset of what real bash runs', () => {
  let directory = ''
  let binary = ''
  let log = ''
  let environment: NodeJS.ProcessEnv = process.env

  /**
   * The sentinel invocations real bash ran on the body, by their joined arguments; empty when bash ran it none. A shape
   * is stopped after `timeout` milliseconds: SHAPE_TIMEOUT for one that runs only bash and the core tools, NEEDS_TIMEOUT
   * for one that starts a program a cold cache can hold for seconds (a cold tsx took 4.7 s in the 7h to 7k review).
   */
  const bashRan = (body: string, timeout = SHAPE_TIMEOUT): Set<string> => {
    writeFileSync(log, '')
    try {
      execFileSync('bash', ['-c', body], { env: environment, cwd: directory, stdio: 'ignore', timeout })
    } catch {
      // A shape may exit non-zero (the sentinel is no git push); the sentinel still recorded whatever it ran.
    }
    return new Set(readFileSync(log, 'utf8').split('\n').slice(0, -1).map(invocation))
  }

  /** Where bash finds a command on the test PATH, or '' when it finds none. */
  const resolved = (name: string): string => {
    try {
      return execFileSync('bash', ['-c', `command -v ${name}`], { env: environment, encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }

  /** Why the control recorded nothing, checked in the order its run needs each part. */
  const sentinelFault = (): string => {
    if (!existsSync('/bin/sh')) return 'there is no /bin/sh, the interpreter the sentinel script names'
    try {
      execFileSync(binary, ['probe'], { env: environment, stdio: 'ignore' })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES') return `the sentinel ${binary} cannot execute (EACCES): ${directory} is mounted noexec or the file lost its execute bit`
      if (code === 'ENOENT') return `the sentinel ${binary} cannot start (ENOENT): its interpreter /bin/sh cannot be run`
      return `the sentinel ${binary} failed when run directly (${code ?? (error as Error).message})`
    }
    if (resolved('find') === '') return 'find is not on PATH, and the control reaches the sentinel through find -exec'
    const found = resolved(SENTINEL)
    if (found !== binary) return `bash resolves ${SENTINEL} to "${found}" rather than ${binary}: a PATH problem`
    return `the sentinel ran but its log ${log} stayed empty`
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'buckle-heredoc-oracle-'))
    binary = join(directory, SENTINEL)
    log = join(directory, 'ran.log')
    writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' "$*" | tr \'\\n\' \' \' >> "$SENTINEL_LOG"\nprintf \'\\n\' >> "$SENTINEL_LOG"\n')
    chmodSync(binary, 0o755)
    // Stand-ins for sudo, doas, su, and ssh (STAND_INS): no shape runs as another user or reaches the network.
    for (const [name, lines] of Object.entries(STAND_INS)) {
      writeFileSync(join(directory, name), `${lines.join('\n')}\n`)
      chmodSync(join(directory, name), 0o755)
    }
    environment = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, SENTINEL_LOG: log }
    const python = resolved('python3')
    if (python !== '') for (const name of BUILD_NAMES) symlinkSync(python, join(directory, name))
    if (!bashRan(CONTROL).has('control')) {
      throw new Error(`heredoc oracle: the control shape ran no sentinel, so no row could fail; ${sentinelFault()}`)
    }
    // Each stand-in must run its command too, or its rows would be ones where bash and Buckle both see nothing.
    for (const [name, [body, marker]] of Object.entries(STAND_IN_CONTROLS)) {
      if (!bashRan(body).has(marker)) throw new Error(`heredoc oracle: the ${name} stand-in ran no sentinel for ${JSON.stringify(body)}, so its rows could not fail`)
    }
  }, 60_000)

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('reads every sentinel command bash runs, for every shape, within the time budget', () => {
    const shapes = allShapes()
    const missed: string[] = []
    let ranShapes = 0
    let overRead = 0
    let unreadShapes = 0
    const skipped: string[] = []
    for (const { label, body, written, unread, whole, needs } of shapes) {
      if (needs !== undefined && resolved(needs) === '') {
        skipped.push(`${label} (${needs} is not on PATH)`)
        continue
      }
      const ran = bashRan(body, needs === undefined ? SHAPE_TIMEOUT : NEEDS_TIMEOUT)
      const forms = commandForms('bash', ['-c', body])
      const read = buckleRan(forms)
      for (const word of unreadByForms(forms)) missed.push(`${label}: the whole-command reading judges the command [${word}], which no form reads`)
      if (needs !== undefined && ran.size === 0) missed.push(`${label}: ${needs} ran no sentinel, so the row proves nothing`)
      if (whole && readLimitOf(forms) !== null) missed.push(`${label}: Buckle marked the call unread (${readLimitOf(forms)}), which it must read whole`)
      if (unread !== undefined) {
        if (readLimitOf(forms) !== unread) missed.push(`${label}: Buckle did not mark the call unread (${unread}), so nothing refuses or asks about what bash ran`)
        unreadShapes++
        continue
      }
      if (written !== undefined) {
        if (ran.size === 0 || !read.has(written)) missed.push(`${label}: Buckle did not read [sentinel ${written}] as written`)
        overRead++
        continue
      }
      for (const invocation of ran) if (!read.has(invocation)) missed.push(`${label}: bash ran [sentinel ${invocation}] that Buckle did not read`)
      if (ran.size > 0) ranShapes++
      else if (read.size > 0) overRead++
    }
    console.info(`heredoc oracle: ${shapes.length} shapes, bash ran the sentinel in ${ranShapes}, ${overRead} read the sentinel where bash did not (over-reads, allowed), ${unreadShapes} unread as expected, ${skipped.length} skipped`)
    for (const reason of skipped) console.info(`heredoc oracle: skipped ${reason}`)
    expect(missed).toEqual([])
  }, ORACLE_BUDGET)
})
