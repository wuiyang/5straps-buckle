import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * One shape: its body, run as `bash -c`. `written` is the invocation Buckle reads where bash runs it expanded (an
 * over-read, see BACKTICK_EXTRA).
 */
interface Shape { label: string; body: string; written?: string }

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

function shapeBody(command: string, delimiter: { open: string; dash: boolean }, lines: string[]): string {
  const tab = delimiter.dash ? '\t' : ''
  const redirect = delimiter.dash ? '<<-' : '<<'
  const indented = lines.map(line => tab + line).join('\n')
  return `${command} ${redirect}${delimiter.open}\n${indented}\n${tab}EOF`
}

function allShapes(): Shape[] {
  const shapes: Shape[] = []
  for (const command of COMMANDS) {
    for (const delimiter of DELIMITERS) {
      for (const [name, lines] of Object.entries(PLACEMENTS)) {
        const kind = `${delimiter.dash ? '<<-' : '<<'}${delimiter.open}`
        shapes.push({ label: `${command} ${kind} ${name}`, body: shapeBody(command, delimiter, lines) })
      }
    }
  }
  return [...shapes, ...NESTED, ...REVIEW_SHAPES, ...ADVERSARIAL, ...backtickShapes(), ...BACKTICK_EXTRA, ...backtickCommentShapes()]
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

/**
 * The reader stays linear on adversarial bulk, needing no bash: a thousand heredocs nested one in another are left
 * unread at the depth limit, and a 1 MB body, 100,000 one-character lines and 50,000 continuations each read within a
 * second (slice 7g review coverage probes).
 */
describe('the reader is bounded on adversarial bulk', () => {
  const under = (body: string, limit = 1_000) => {
    const started = performance.now()
    const forms = commandForms('bash', ['-c', body])
    expect(performance.now() - started).toBeLessThan(limit)
    return forms
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
})

describe.skipIf(!hasBash)('heredoc and continuation shapes read a superset of what real bash runs', () => {
  let directory = ''
  let binary = ''
  let log = ''
  let environment: NodeJS.ProcessEnv = process.env

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
    writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SENTINEL_LOG"\n')
    chmodSync(binary, 0o755)
    environment = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, SENTINEL_LOG: log }
    if (!bashRan(CONTROL).has('control')) {
      throw new Error(`heredoc oracle: the control shape ran no sentinel, so no row could fail; ${sentinelFault()}`)
    }
  })

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('reads every sentinel command bash runs, for every shape, within the time budget', () => {
    const shapes = allShapes()
    const missed: string[] = []
    let ranShapes = 0
    let overRead = 0
    for (const { label, body, written } of shapes) {
      const ran = bashRan(body)
      const read = buckleRan(body)
      if (written !== undefined) {
        if (ran.size === 0 || !read.has(written)) missed.push(`${label}: Buckle did not read [sentinel ${written}] as written`)
        overRead++
        continue
      }
      for (const invocation of ran) if (!read.has(invocation)) missed.push(`${label}: bash ran [sentinel ${invocation}] that Buckle did not read`)
      if (ran.size > 0) ranShapes++
      else if (read.size > 0) overRead++
    }
    console.info(`heredoc oracle: ${shapes.length} shapes, bash ran the sentinel in ${ranShapes}, ${overRead} read the sentinel where bash did not (over-reads, allowed)`)
    expect(missed).toEqual([])
  }, 20_000)
})
