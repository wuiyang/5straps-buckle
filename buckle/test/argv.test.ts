import { describe, expect, it } from 'vitest'
import { argvIdentity, commandSubject, envSplitWords, expansionShape, gitInvocation, hasFlag, holdsExpansion, parseArgv, shellScriptSource, shellStartupFiles, shellStatementList, shellTokens, shownCommand, sshCommandSetting, sshInvocation, statementPieces, suInvocation } from '../common/domain/argv.js'
import { commandForms, readLimitOf } from '../common/domain/command-forms.js'

describe('parseArgv', () => {
  it('expands clustered short flags', () => {
    const argv = parseArgv('rm', ['-rf', 'build'])
    expect([...argv.shortFlags]).toEqual(['r', 'f'])
    expect(argv.positionals).toEqual(['build'])
  })

  it('splits long flags with values', () => {
    const argv = parseArgv('git', ['log', '--max-count=10'])
    expect(argv.longFlags.get('max-count')).toBe('10')
    expect(argv.subcommand).toBe('log')
  })

  it('stops flag parsing at a bare double dash', () => {
    const argv = parseArgv('pnpm', ['run', '--', '-rf'])
    expect(argv.shortFlags.size).toBe(0)
    expect(argv.positionals).toEqual(['run', '-rf'])
  })

  it('treats a lone dash as a positional', () => {
    expect(parseArgv('cat', ['-']).positionals).toEqual(['-'])
  })

  it('reduces a path to its base command', () => {
    expect(parseArgv('/usr/bin/rm', []).command).toBe('rm')
  })
})

// Slice 7h probes: a shell whose script arrives as data (a pipe, a redirection, xargs) runs what no reading sees, so
// where a shell takes its script from is read as its options say.
describe('shellScriptSource', () => {
  it.each<[string[], ReturnType<typeof shellScriptSource>]>([
    [['-c', 'git push'], 'command'],
    [['-ec', 'git push'], 'command'],
    [['-o', 'pipefail', '-c', 'git push'], 'command'],
    [['-c', '--', 'git push'], 'command'],
    [['-c'], 'missingCommand'],
    [['-x', '-c'], 'missingCommand'],
    [[], 'input'],
    [['-s', 'one', 'two'], 'input'],
    [['-'], 'input'],
    [['--'], 'input'],
    [['/dev/stdin'], 'input'],
    [['-x', '/dev/fd/0'], 'input'],
    [['--norc', '-i'], 'input'],
    [['build.sh'], 'file'],
    [['-o', 'pipefail', 'build.sh', 'arg'], 'file'],
    [['--rcfile', 'rc', 'build.sh'], 'file'],
    [['--', '-script'], 'file'],
    [['--version'], 'none'],
    [['--help'], 'none'],
    // Slice 7l: the path normalised before it is read, and any other descriptor or device is data too.
    [['//dev/stdin'], 'input'],
    [['/dev//stdin'], 'input'],
    [['/dev/./stdin'], 'input'],
    [['/proc/thread-self/fd/0'], 'input'],
    [['../../../dev/stdin'], 'input'],
    [['/dev/fd/3'], 'descriptor'],
    [['/proc/self/fd/3'], 'descriptor'],
    [['/proc/1/fd/0'], 'descriptor'],
    [['/proc/self/root/dev/stdin'], 'descriptor'],
    [['scripts/build.sh'], 'file'],
    [['./stdin'], 'file'],
  ])('reads a shell given %j as taking its script from: %s', (args, source) => {
    expect(shellScriptSource(args)).toBe(source)
  })
})

// The startup files bash's own options name, read up to the shell's first operand.
describe('shellStartupFiles', () => {
  it.each<[string[], string[]]>([
    [['--rcfile', 'a', '--init-file', 'b', '-i', '-c', 'true'], ['a', 'b']],
    [['-o', 'pipefail', '--rcfile', 'a', '-i'], ['a']],
    [['-c', 'true', '--rcfile', 'a'], []],
    [['script.sh', '--rcfile', 'a'], []],
    [['--rcfile'], []],
  ])('reads %j as naming the startup files %j', (args, files) => {
    expect(shellStartupFiles(args)).toEqual(files)
  })
})

// Slice 7l: a word whose value an expansion supplies, which a shell -c string must not be read as written.
describe('holdsExpansion', () => {
  it.each([
    ['"$(echo x)"', true], ['"$x"', true], ['$x', true], ['`id`', true], ['*.sh', true], ['a?', true], ['[ab]', true], ["{'a b',c}", true],
    ['{1..3}', true], ['~/bin', true], ["'$x'", false], ["$'a\\'b'", false], ['\\$x', false], ['"\\$x"', false], ['{}', false], ["'*'", false],
    ['"*"', false], ['plain', false], ['a~b', false],
  ])('reads %s as holding an expansion: %s', (raw, expanded) => {
    expect(holdsExpansion(raw)).toBe(expanded)
  })
})

// An expansion outside double quotes, a pattern, a brace expansion, "$@", and "${a[@]}" may make a word several; the
// text before the first expansion is the word's own.
describe('expansionShape', () => {
  it.each<[string, boolean, string]>([
    ['$v', true, ''], ['"$v"', false, ''], ['"${v}"', false, ''], ['"$(echo "a b")"', false, ''], ['"`id`"', false, ''], ['$(id)', true, ''],
    ['"$@"', true, ''], ['"${@:2}"', true, ''], ['"${a[@]}"', true, ''], ['"${!a[@]}"', true, ''], ['"${#a[@]}"', false, ''], ['"$*"', false, ''],
    ['"${a[*]}"', false, ''], ['{1,2}', true, ''], ['*.ts', true, ''], ['a?', true, 'a'], ['~/x', false, ''], ['--signal="$s"', false, '--signal='],
    ['-n"$v"', false, '-n'], ['-n$v', true, '-n'], ['user@"$HOST"', false, 'user@'], ['"user@$HOST"', false, 'user@'], ['X=$v', true, 'X='],
    ['FOO="$BAR"', false, 'FOO='], ["'-'\"$x\"", false, '-'], ['"$(a)"$b', true, ''], ['"$a"*', true, ''], ['x<$()', false, 'x'], ["$'\\x2d'\"$v\"", false, '-'],
  ])('reads %s as splitting: %s, its own text first: %j', (raw, splits, prefix) => {
    expect(expansionShape(raw)).toEqual({ splits, prefix })
  })
})

// Review M6: the subcommand git runs sits after git's own options and their values.
describe('gitInvocation', () => {
  it.each<[string[], string | null, string[]]>([
    [['-C', '.', 'push', '--force'], 'push', ['--force']],
    [['-c', 'k=v', 'push', '-f'], 'push', ['-f']],
    [['--git-dir', '.git', '--work-tree', '.', 'reset', '--hard'], 'reset', ['--hard']],
    [['--git-dir=.git', '-p', '--bare', '--no-optional-locks', 'clean', '-fdx'], 'clean', ['-fdx']],
    [['--namespace', 'n', '--config-env', 'k=ENV', '--exec-path=/x', 'checkout', '-f'], 'checkout', ['-f']],
    [['--literal-pathspecs', '--icase-pathspecs', 'status'], 'status', []],
    [['-C', 'only'], null, []],
  ])('finds the subcommand of git %j', (args, subcommand, rest) => {
    expect(gitInvocation(args)).toEqual({ subcommand, args: rest })
  })

  // Review L11 of the slice 5 re-review: git 2.43 answers a bare `--` there with "unknown option: --" (exit 129).
  it.each<[string[]]>([
    [['--', 'push', '--force']],
    [['-C', 'a', '--', 'push', '--force']],
    [['-c', 'k=v', '--', 'status']],
  ])('names no subcommand for git %j, whose bare -- git refuses, and marks it', (args) => {
    expect(gitInvocation(args)).toEqual({ subcommand: null, args: [], doubleDash: true })
    expect(parseArgv('git', args).subcommand).toBeNull()
  })

  it('names that subcommand in parseArgv for git alone', () => {
    expect(parseArgv('git', ['-C', '.', 'push', '--force']).subcommand).toBe('push')
    expect(parseArgv('/usr/bin/git', ['--git-dir', '.git', 'Reset']).subcommand).toBe('reset')
    expect(parseArgv('pnpm', ['-C', '.', 'build']).subcommand).toBe('.')
  })
})

describe('hasFlag', () => {
  it('matches either the short or a long spelling', () => {
    const argv = parseArgv('git', ['push', '--force-with-lease'])
    expect(hasFlag(argv, 'f', 'force', 'force-with-lease')).toBe(true)
    expect(hasFlag(argv, null, 'hard')).toBe(false)
  })
})

// Owner decision D17 and the GPT review of c71dee5 (session command identity): the grant subject joined the
// words with spaces and cut them at 300 characters, so `rm -f 'a b'` and `rm -f a b` shared one grant.
describe('a command\'s identity and display (owner decision D17)', () => {
  it('shows the command whole, each word quoted as a shell needs it, so its boundaries show', () => {
    expect(shownCommand('rm', ['-rf', 'build'])).toBe('rm -rf build')
    expect(shownCommand('rm', ['-f', 'a b'])).toBe("rm -f 'a b'")
    expect(shownCommand('rm', ['-f', 'a', 'b'])).toBe('rm -f a b')
    expect(shownCommand('echo', ['', "it's", '$HOME', 'a;b', '*', '--x=1'])).toBe(`echo '' 'it'\\''s' '$HOME' 'a;b' '*' --x=1`)
    expect(shownCommand('A=1', [])).toBe("'A=1'")
  })

  it('keeps argument boundaries apart: two lists that join to the same text have different subjects', () => {
    expect(argvIdentity('rm', ['-f', 'a b'])).not.toBe(argvIdentity('rm', ['-f', 'a', 'b']))
    expect(commandSubject('rm', ['-f', 'a b'])).not.toBe(commandSubject('rm', ['-f', 'a', 'b']))
    expect(commandSubject('rm', ['-f', 'a b'])).toMatch(/^rm -f 'a b'  # argv sha256 [a-f0-9]{64}$/)
  })

  it('keeps commands that differ after character 300 apart, and shows both whole', () => {
    const head = 'x'.repeat(400)
    const left = commandSubject('rm', ['-f', `${head}-left`])
    const right = commandSubject('rm', ['-f', `${head}-right`])
    expect(left).not.toBe(right)
    expect(left).toContain(`${head}-left`)
    expect(right).toContain(`${head}-right`)
  })

  it('hides a URL password in the display but keeps two different credentials apart (owner ruling B)', () => {
    const first = commandSubject('git', ['push', '--force', 'https://bot:tok-first@github.com/org/repo.git', 'main'])
    const second = commandSubject('git', ['push', '--force', 'https://bot:tok-second@github.com/org/repo.git', 'main'])
    expect(first).not.toBe(second)
    for (const subject of [first, second]) {
      expect(subject).not.toMatch(/tok-(first|second)/)
      expect(subject).toMatch(/^git push --force 'https:\/\/bot:\[redacted\]@github.com\/org\/repo.git' main  # argv sha256 [a-f0-9]{64}$/)
    }
  })
})

/** Every statement of shell text as a shell splits it, then every piece of each: the candidates the rules judge. */
function statementsOf(text: string): string[] {
  const { statements } = shellStatementList(text)
  return [...new Set([...statements, ...statements.flatMap(statementPieces)])]
}

// Slice 7 review F2: the rules read a quoted operator as the word a shell hands on, so a token keeps its raw form.
describe('shell text as a shell splits it', () => {
  it('joins a quoted run to the word it touches and removes quotes and backslashes as a shell does', () => {
    const text = `--force'>' a\\ b "x\\"y\\$" 'it''s' '' \\> 2>out "unclosed`
    expect(shellTokens(text)).toEqual([
      { raw: `--force'>'`, word: '--force>' },
      { raw: 'a\\ b', word: 'a b' },
      { raw: '"x\\"y\\$"', word: 'x"y$' },
      { raw: `'it''s'`, word: 'its' },
      { raw: `''`, word: '' },
      { raw: '\\>', word: '>' },
      { raw: '2>out', word: '2>out' },
      { raw: '"unclosed', word: 'unclosed' },
    ])
  })

  // Slice 7b review W7B-5: `$'\''` read as `$`, a closed `'\'` and an unclosed quote that took the rest of the statement.
  it('reads ANSI-C quoting with its backslash escapes as one word, as bash does', () => {
    expect(shellTokens("rm $'\\'' -rf build").map(token => token.word)).toEqual(['rm', "'", '-rf', 'build'])
    expect(shellTokens("x$'a\\'b' $'\\x2drf\\n' \"$'\"").map(token => token.word)).toEqual(["xa'b", '-rf\n', "$'"])
    expect(statementsOf("git clean -e $'\\'' -f; ls")).toEqual(["git clean -e $'\\'' -f", 'ls'])
  })

  // Slice 7h probe: bash removes a backslash-newline outside single quotes before it splits words, so a continuation
  // inside a command name or a flag (`gi\` then `t push`, `--for\` then `ce`) ran a git push or a force push that every
  // rule read as two words.
  it('joins the word a backslash-newline continues, outside single quotes, as bash does', () => {
    const words = (text: string) => shellTokens(text).map(token => token.word)
    expect(words('gi\\\nt push --for\\\nce origin main')).toEqual(['git', 'push', '--force', 'origin', 'main'])
    expect(words('git push \\\n--force \\\n\\\n main')).toEqual(['git', 'push', '--force', 'main'])
    expect(words('git "--for\\\nce" x\\\\\\\ny')).toEqual(['git', '--force', 'x\\y'])
    expect(words("git '--for\\\nce'")).toEqual(['git', '--for\\\nce'])
  })

  // Slice 7b review W7B-4: an apostrophe in a comment or a heredoc body opened a quote that took the lines after it.
  it('drops a comment and reads a heredoc body line by line, so its quotes end with the line', () => {
    expect(statementsOf("# don't\ngit clean -e ';' -f")).toEqual(["git clean -e ';' -f", "git clean -e '", "' -f"])
    expect(statementsOf("echo a#b # it's\nls")).toEqual(['echo a#b', 'ls'])
    expect(statementsOf("cat <<'EOF' > notes\nit's\nEOF\nrm '|' -rf x")).toEqual(['cat <<\'EOF\' > notes', "it's", "rm '|' -rf x", "rm '", "' -rf x"])
  })

  // Slice 7e review R7E-LW-1 and R7E-LW-2: a heredoc body line dropped its MAX_SUBSTITUTIONS flag, and its quotes were
  // read as shell quotes, although under an unquoted delimiter bash runs every substitution in the body, quoted or not.
  it('reads a heredoc body under an unquoted delimiter as heredoc text too, its quotes and comments literal', () => {
    expect(statementsOf("cat <<EOF\nfind . -exec true '$(git push origin main)' \\;\nEOF")).toEqual(['cat <<EOF', "find . -exec true '$(git push origin main)' \\;", 'git push origin main', "find . -exec true '", "' \\"])
    expect(statementsOf("cat <<EOF\necho '`id`' \"it's\" # $(ls)\nEOF")).toEqual(['cat <<EOF', "echo '`id`' \"it's\"", 'id', 'ls', "echo '", "' \"it's\""])
    expect(statementsOf("cat <<EOF\necho '$(git push \\\norigin main)'\nEOF")).toContain('git push origin main')
    expect(statementsOf("cat <<'EOF'\necho '$(id)'\nEOF")).toEqual(["cat <<'EOF'", "echo '$(id)'", "echo '", 'id', "'"])
    expect(shellStatementList("cat <<'EOF'\nfind . -exec true '$(git push origin main)' \\;\nEOF").statements).toEqual(["cat <<'EOF'", "find . -exec true '$(git push origin main)' \\;"])
  })

  // Slice 7f residual 1: heredoc body lines a backslash-newline joins were read one at a time, so `git push \` then
  // `--force origin main` fed to bash showed no force push, although real bash force-pushed.
  it('reads heredoc body lines a backslash-newline joins as one statement too, under either delimiter', () => {
    const statements = (text: string) => shellStatementList(text).statements
    // A quoted body fed to a shell is also read whole as shell text, so its line continuations join across lines.
    expect(statements("bash <<'EOF'\ngit push \\\n--force \\\norigin main\nEOF")).toEqual(["bash <<'EOF'", 'git push \\', '--force \\', 'origin main', 'git push --force origin main', 'git push \\\n--force \\\norigin main'])
    // The joined line keeps the tab bash keeps (a continued line is part of the line before it under <<-).
    expect(statements('bash <<-EOF\n\tgit push \\\n\t--force origin main\n\tEOF')).toEqual(['bash <<-EOF', 'git push \\', '--force origin main', 'git push --force origin main', 'git push \t--force origin main'])
    // A run still open at the delimiter line is read as it stands, and the delimiter line still ends the body.
    expect(statements("bash <<'EOF'\ngit push --force \\\nEOF\necho after")).toEqual(["bash <<'EOF'", 'git push --force \\', 'git push --force', 'echo after'])
    // An escaped backslash ends no line under a quoted delimiter; under an unquoted one bash halves it first, so it does.
    expect(statements("bash <<'EOF'\ngit push \\\\\n--force origin main\nEOF")).toEqual(["bash <<'EOF'", 'git push \\\\', '--force origin main'])
    // The unquoted body is also read as the fed shell receives it: `\\` halves to `\`, which then continues the line.
    expect(statements('bash <<EOF\ngit push \\\\\n--force origin main\nEOF')).toEqual(['bash <<EOF', 'git push \\\\', '--force origin main', 'git push --force origin main', 'git push \\\n--force origin main'])
    // Four backslashes halve to two, which escape each other, so the line does not continue in the fed shell.
    expect(statements('bash <<EOF\ngit push \\\\\\\\\n--force origin main\nEOF')).toEqual(['bash <<EOF', 'git push \\\\\\\\', '--force origin main', 'git push \\\\'])
  })

  // Slice 7f review R7F-HR-1 and R7F-HR-2: an unquoted heredoc body is read as the fed shell receives it, so a
  // substitution a backslash hid is read; and the delimiter test runs after a backslash-newline joins a line to the
  // next, so a delimiter line that ends a continuation is body text. A quoted delimiter unescapes and joins nothing.
  it('reads an unquoted heredoc body as the fed shell receives it, escapes resolved and continuations joined first', () => {
    const statements = (text: string) => shellStatementList(text).statements
    // R7F-HR-1: `\$` and an escaped backtick in a double-quoted find argument become `$` and a backtick, so the
    // substitution they hid is read; a quoted delimiter leaves them literal and reads no git push.
    expect(statements('bash <<EOF\nfind . -maxdepth 0 -exec true "\\$(git push origin main)" \\;\nEOF')).toContain('git push origin main')
    expect(statements('bash <<EOF\nfind . -maxdepth 0 -exec true "\\`git push origin main\\`" \\;\nEOF')).toContain('git push origin main')
    expect(statements("bash <<'EOF'\nfind . -maxdepth 0 -exec true \"\\$(git push origin main)\" \\;\nEOF")).not.toContain('git push origin main')
    // `git push \\--force` reaches the fed shell as `git push \--force`, which is `git push --force`.
    expect(statements('bash <<EOF\ngit push \\\\--force origin main\nEOF')).toContain('git push \\--force origin main')
    // R7F-HR-2: `x \` continues into the delimiter line, which is swallowed, so the body runs to the next delimiter
    // and its find line expands; under a quoted delimiter the first delimiter line ends the body and nothing expands.
    const swallow = 'cat <<EOF\nx \\\nEOF\nfind . -maxdepth 0 -exec true \'$(git push origin main)\' \\;\nEOF'
    expect(statements(swallow)).toEqual(['cat <<EOF', 'x \\', 'EOF', 'x EOF', "find . -maxdepth 0 -exec true '$(git push origin main)' \\;", 'git push origin main'])
    expect(statements("cat <<'EOF'\nx \\\nEOF\nfind . -maxdepth 0 -exec true '$(git push origin main)' \\;\nEOF")).not.toContain('git push origin main')
  })

  // Slice 7h probes: under `<<-EOF` bash strips the leading tabs of each logical line only, so the line five
  // backslashes join on keeps its tab: the fed shell receives `git push \\`, a tab, then `--force`, a force push whose
  // `\` is a word of its own. Stripping every line read `git push \--force`, which is no flag. A quoted delimiter joins
  // nothing in the heredoc, so each line loses its tabs before the fed shell joins them.
  it('keeps the tabs of a line a continuation joins on under <<-, as bash feeds it', () => {
    const statements = (text: string) => shellStatementList(text).statements
    expect(statements('bash <<-EOF\n\tgit push \\\\\\\\\\\n\t--force origin main\n\tEOF')).toContain('git push \\\\\t--force origin main')
    expect(statements("bash <<-'EOF'\n\tgit push \\\n\t--force origin main\n\tEOF")).toContain('git push \\\n--force origin main')
  })

  // Slice 7f review R7F-HR-3 and R7F-HR-4: every body is read whole as shell text, since a quoted body too may be fed
  // to a shell; a heredoc nested in a whole reading is read whole in turn, up to MAX_DEPTH, past which it is unread.
  it('reads every heredoc body whole as shell text, its nested bodies whole too up to the depth limit', () => {
    const statements = (text: string) => shellStatementList(text).statements
    // R7F-HR-3: a quoted body fed to bash, with an inner unquoted heredoc that expands; and a double quote spanning
    // body lines with the substitution on the middle line. The per-line readings miss both; the whole reading does not.
    expect(statements("bash <<'EOF'\ncat <<X\nfind . -maxdepth 0 -exec true '$(git push origin main)' \\;\nX\nEOF")).toContain('git push origin main')
    expect(statements("bash <<'EOF'\nfind . -maxdepth 0 -exec true \"\nfind . -maxdepth 0 -exec true ' $(git push origin main) ' \\;\n\" \\;\nEOF")).toContain('git push origin main')
    // R7F-HR-4: a heredoc nested inside the whole reading of an unquoted body, its substitution spanning its lines.
    expect(statements("cat <<EOF\n$(cat <<X\nx '$(\"\nfind . -maxdepth 0 -exec true \" ;git push origin main; \" \\;\n\")'\nX\n)\nEOF")).toContain('git push origin main')
    // Nested whole readings up to MAX_DEPTH leave the deepest unread; a body nested one level deeper is overDepth.
    const nest = (depth: number) => `${Array.from({ length: depth }, (_, index) => `bash <<'E${index}'`).join('\n')}\necho x\n${Array.from({ length: depth }, (_, index) => `E${depth - 1 - index}`).join('\n')}`
    expect(shellStatementList(nest(8)).overDepth).toBe(false)
    expect(shellStatementList(nest(9)).overDepth).toBe(true)
  })

  it('says a heredoc body nests substitutions past MAX_SUBSTITUTIONS, whatever its delimiter', () => {
    for (const opener of ['cat <<EOF', "cat <<'EOF'", 'bash <<-EOF']) {
      expect(shellStatementList(`${opener}\necho "$(a "$(b "$(c "$(d "$(git push)")")")")"\nEOF`).deep).toBe(true)
      expect(shellStatementList(`${opener}\necho "$(a "$(b "$(c "$(git push)")")")"\nEOF`).deep).toBe(false)
    }
  })

  // Slice 7h probes: bash removes a backslash before `\`, a backtick or `$` in a backtick body before it parses the
  // body, and before `"` too when double quotes hold it, so `\\--force` there runs `--force`; the reader read `\--force`.
  it('reads a backtick body as bash runs it too, its escapes removed first and each nested body in turn', () => {
    const statements = (text: string) => shellStatementList(text).statements
    expect(statements('echo `git push \\\\--force origin main`')).toEqual(['echo', 'git push \\\\--force origin main', 'git push \\--force origin main'])
    expect(statements('echo "`git push \\"--force\\" origin main`"')).toContain('git push "--force" origin main')
    expect(statements('echo `echo \\`git push \\\\\\\\--force origin main\\``')).toContain('git push \\--force origin main')
    expect(statements("cat <<EOF\necho `git push \\\\--force`\nEOF")).toContain('git push \\--force')
    // A body with no backslash reads the same either way, so it is read once.
    expect(statements('echo `git push --force`')).toEqual(['echo', 'git push --force'])
  })

  // Slice 7i probes: bash finds a backtick body's end before it reads a comment in it, so the comment stops there and
  // the command after the substitution is read; outside a backtick body a comment still runs to the end of its line.
  it('ends a comment inside a backtick body at its closing backtick', () => {
    expect(statementsOf('echo `id # c`; git push origin main')).toContain('git push origin main')
    expect(statementsOf('echo "`id # c`"; git push origin main')).toContain('git push origin main')
    expect(statementsOf("bash <<'EOF'\necho `id # c \\` x`; git push origin main\nEOF")).toContain('git push origin main')
    expect(statementsOf('echo $(id # c ); git push origin main\n)')).not.toContain('git push origin main')
  })

  // Quotes nest as bash nests them: a `$(...)`, `<(...)`, `${...}`, or backtick body starts a fresh quoting context,
  // inside double quotes and out, so a word holding one ends where bash ends it, the expansion kept as written. A word
  // ended at the inner quote read `x="$(echo "a b")" git push` as the command `b)` while bash ran git push.
  it.each([
    ['x="$(echo "a b")" git push', ['x=$(echo "a b")', 'git', 'push']],
    ['x="${q:-"a b"}" git push', ['x=${q:-"a b"}', 'git', 'push']],
    ['x=${q:-a b} git push', ['x=${q:-a b}', 'git', 'push']],
    [`x="\${q:-'}'}" git`, [`x=\${q:-'}'}`, 'git']],
    ['x="$(echo "$(echo "c d")")" git', ['x=$(echo "$(echo "c d")")', 'git']],
    [`x="$(echo ')')" git`, [`x=$(echo ')')`, 'git']],
    ['x="$(f() { :; }; echo ")")" git', ['x=$(f() { :; }; echo ")")', 'git']],
    ['x="$(case a in a) echo "q r";; esac)" git', ['x=$(case a in a) echo "q r";; esac)', 'git']],
    ['x=$(case a in (a) echo;; esac) git', ['x=$(case a in (a) echo;; esac)', 'git']],
    ['x="`echo \\"a b\\"`" git', ['x=`echo \\"a b\\"`', 'git']],
    ['x="$(( "1" + (2) ))" git', ['x=$(( "1" + (2) ))', 'git']],
    ['x="$(cat <<EOF\n) "\nEOF\n)" git', ['x=$(cat <<EOF\n) "\nEOF\n)', 'git']],
    ['x="$(echo a # ) "\n)" git', ['x=$(echo a # ) "\n)', 'git']],
    ['cat <(echo a b) x', ['cat', '<(echo a b)', 'x']],
    ['echo $(echo "a b") `echo "c d"` x', ['echo', '$(echo "a b")', '`echo "c d"`', 'x']],
  ])('reads %j as the words %j, each expansion one word', (text, words) => {
    expect(shellTokens(text).map(token => token.word)).toEqual(words)
  })

  // The statements split as bash splits them: a parameter expansion's braces hold their separators, and a case pattern's
  // `)` inside a substitution closes neither the substitution nor the double quotes around it.
  it.each([
    ['x=${q:-a;b} git push', ['x=${q:-a;b} git push'], []],
    ['x="${q:-"a;b"}" git push', ['x="${q:-"a;b"}" git push'], []],
    ['x="${q:-$(echo "a;b")}" git push', ['echo "a;b"', 'x="${q:-$(echo "a;b")}" git push'], ['x="${q:-$()}" git push']],
    ['x="$(case a in a) echo "q;r";; esac)" git push', ['case a in a', 'echo "q;r"', 'esac', 'x="$(case a in a) echo "q;r";; esac)" git push'], ['x="$()" git push']],
    ['echo $(case a in (a) x;; b|c) y;; esac); git push', ['echo $', 'case a in', 'a', 'x', 'b', 'c', 'y', 'esac', 'git push'], ['echo $$()']],
  ])('splits %j into the statements %j and the heads %j', (text, statements, heads) => {
    const list = shellStatementList(text)
    expect(list.statements).toEqual(statements)
    expect([...list.heads.keys()]).toEqual(heads)
  })

  // A backslash that ends the text escapes nothing and bash keeps it; an escaped space ending a statement is a word.
  it('keeps a backslash that ends the text, and an escaped space that ends a statement', () => {
    expect(shellTokens('git push --force\\').map(token => token.word)).toEqual(['git', 'push', '--force\\'])
    expect(shellStatementList('git push \\ \nls\\\n').statements).toEqual(['git push \\ ', 'ls'])
  })

  it('reads each $(...) or backtick body inside double quotes as statements of its own', () => {
    expect(statementsOf('echo "$(git push -f; ls)" `id`')).toEqual(['git push -f', 'ls', 'echo "$(git push -f; ls)"', 'id', 'echo "', '"'])
  })

  it('keeps a quoted separator inside its statement and still offers the textual split as candidates', () => {
    expect(statementsOf("git clean -e ';' -f && echo ok")).toEqual(["git clean -e ';' -f", 'echo ok', "git clean -e '", "' -f"])
    expect(statementsOf('find . -exec rm {} \x5c; ; ls')).toEqual(['find . -exec rm {} \x5c;', 'ls', 'find . -exec rm {} \x5c'])
  })
})

describe('a word an unquoted < or > ends (fix brief 6, A3)', () => {
  it('starts a redirection there, its descriptor digits with it only when they are the whole word so far', () => {
    const raw = (text: string) => shellTokens(text).map(token => token.raw)
    expect(raw('echo a>b')).toEqual(['echo', 'a', '>b'])
    expect(raw('rm>/dev/null -rf x')).toEqual(['rm', '>/dev/null', '-rf', 'x'])
    expect(raw('cmd 2>err a2>out')).toEqual(['cmd', '2>err', 'a2', '>out'])
    expect(raw('cat <in>out 2>&1>>log')).toEqual(['cat', '<in', '>out', '2>&1', '>>log'])
    expect(raw('cat<<EOF>out')).toEqual(['cat', '<<EOF', '>out'])
    expect(raw("x'>'y \\>z \"a>b\"")).toEqual(["x'>'y", '\\>z', '"a>b"'])
    expect(raw('echo a<(true) b>(true)')).toEqual(['echo', 'a<(true)', 'b>(true)'])
  })

  it('still reads echo a>b as echo with the operand a, its output going to b', () => {
    expect(commandForms('bash', ['-c', 'echo a>b']).nested).toContainEqual(['echo', 'a'])
  })
})

// A substitution, an array, an extended glob, or arithmetic cuts the statement it sits in, so no piece shows which word
// is the command word; the command is also kept whole, as a head, each body replaced by `$()`.
describe('the commands a substitution cuts, kept whole', () => {
  const headsOf = (text: string) => [...shellStatementList(text).heads.keys()]

  it.each([
    ['$(echo git) push origin', ['$$() push origin']],
    ['`echo git` push origin', ['$() push origin']],
    ['g$(echo it) push', ['g$$() push']],
    ['x=$(echo a b) $(echo git) push', ['x=$$() $$() push']],
    ['x="$(echo "a b")" $y push', ['x="$()" $y push']],
    ['sudo $(echo git) push; ls', ['sudo $$() push']],
    ['echo $((1 + $x)); a=($y z); @(x) push', ['echo $$()', 'a=$()', '@$() push']],
    ['(($x push); true)', []],
    ['git push', []],
  ])('keeps %j whole as %j', (text, heads) => {
    expect(headsOf(text)).toEqual(heads)
  })

  it('marks the pieces of a cut command, and the words of arithmetic and of an array, as no whole command', () => {
    const { seen } = shellStatementList('$(echo git) push; echo $(($i + 1)); a=($x y); (( $j > 0 )); $z mark')
    expect([...seen].filter(([, known]) => !known.whole).map(([statement]) => statement)).toEqual(['$', 'push', 'echo $', '$i + 1', 'a=', '$x y', '$j > 0'])
    expect([...seen].filter(([, known]) => known.whole).map(([statement]) => statement)).toEqual(['echo git', '$z mark'])
  })

  // A heredoc body read as shell text is a safety net unless its command may feed it to a shell; its lines read alone
  // always are.
  it('marks a body read whole as a safety net when its command feeds no shell, and each line read alone always', () => {
    const feedsShell = (owner: string) => /^(bash|sh)\b/.test(owner)
    const net = (text: string) => [...shellStatementList(text, undefined, feedsShell).seen].filter(([, known]) => known.net).map(([statement]) => statement)
    expect(net("cat > Makefile <<'EOF'\n\t$(CC) -o x\n\"$PYTHON\" x.py\nEOF")).toEqual(['$', 'CC', '-o x', '"$PYTHON" x.py'])
    expect(net("bash <<'EOF'\necho \"a\n$x b\n\"\nEOF")).toEqual(['echo "a', '$x b', '"'])
    expect(net("bash <<'EOF'\n$x b\nEOF")).toEqual([])
  })
})

// A statement's input may come from the call's own text: after a `|` until the pipeline ends outside the compound
// commands open when it began, through a feed on a compound's closing word, or a heredoc, a here-string, or a process
// substitution on the command itself, which reaches no substitution inside it.
describe('the statements whose input the call\'s own text feeds', () => {
  const fedOf = (text: string) => [...shellStatementList(text).seen].filter(([, known]) => known.fed).map(([statement]) => statement)

  it.each([
    ['echo x | bash l; bash m', ['bash l']],
    ['echo x | { a; bash l; }; bash m', ['{ a', 'bash l', '}']],
    ['echo x | while read -r v; do bash l; done && bash m', ['while read -r v', 'do bash l', 'done']],
    ['make && bash l || bash m', []],
    ['echo x |& bash l', ['bash l']],
    ['bash l <<< x; bash m', ['bash l <<< x']],
    ['cat $(bash l) <<< x', ['cat $', '<<< x']],
    ['{ a; bash l; } < <(echo x); bash m', ['{ a', 'bash l', '} < <', 'echo x']],
    ['exec 3<<< x; bash l', ['exec 3<<< x', 'bash l']],
    ['f() { bash l; }; echo x | f', ['f', '{ bash l', '}', 'echo x']],
  ])('reads %j as feeding %j', (text, fed) => {
    expect(fedOf(text)).toEqual(fed)
  })

  // A body line led by `function` that a backslash continues is read as a definition, as the whole reading reads one, so
  // once anything is fed every statement is; the same line with no special character is one plain statement.
  it.each([
    ["echo x | cat; bash l\ncat <<'EOF'\nfunction f \\\nEOF", ['echo x', 'cat', 'bash l', "cat <<'EOF'", 'function f \\', 'function f']],
    ["echo x | cat; bash l\ncat <<'EOF'\nfunction f\nEOF", ['cat', "cat <<'EOF'"]],
  ])('reads %j as feeding %j, by whether a body line defines a function', (text, fed) => {
    expect(fedOf(text)).toEqual(fed)
  })

  it('reads the line after a here-string as a command, not a heredoc body', () => {
    const { seen } = shellStatementList('cat <<< x\n$y mark', undefined, () => false)
    expect(seen.get('$y mark')?.net).toBe(false)
  })
})

// Slice 7i residual and owner decision D7: `sudo git push` was read as `sudo` alone. Each wrapper's options are read
// as its getopt string reads them, so the command after them is read as a command of its own.
describe('the command a wrapper runs', () => {
  it('reads a NAME=value word as an assignment only at a statement head and in env and sudo, else as a program path beside it (fix brief 6, A7)', () => {
    expect(commandForms('FOO=1', ['python3', 'a.py']).chain).toEqual([['FOO=1', 'python3', 'a.py'], ['python3', 'a.py']])
    expect(commandForms('FOO=/w/x', ['python3', 'a.py']).chain).toEqual([['FOO=/w/x', 'python3', 'a.py'], ['python3', 'a.py']])
    expect(commandForms('env', ['FOO=1', 'python3', 'a.py']).chain).toEqual([['env', 'FOO=1', 'python3', 'a.py'], ['python3', 'a.py']])
    expect(commandForms('sudo', ['FOO=/w/x', 'python3', 'a.py']).chain).toEqual([['sudo', 'FOO=/w/x', 'python3', 'a.py'], ['python3', 'a.py']])
    expect(commandForms('nice', ['FOO=/bin/rm', 'x']).chain).toEqual([['nice', 'FOO=/bin/rm', 'x'], ['FOO=/bin/rm', 'x'], ['rm', 'x'], ['x']])
  })

  const runs = (command: string, args: string[]) => commandForms(command, args).chain.at(-1)

  it.each<[string, string[]]>([
    ['sudo', ['git', 'push']],
    ['sudo', ['-u', 'root', 'git', 'push']],
    ['sudo', ['-uroot', 'git', 'push']],
    ['sudo', ['-nE', '-u', 'root', 'git', 'push']],
    ['sudo', ['-g', 'wheel', '-h', 'host', '-p', 'prompt', '-C', '3', '-D', '/', '-R', '/', '-T', '10', '-U', 'root', 'git', 'push']],
    ['sudo', ['-r', 'role', '-t', 'type', '-a', 'style', '-c', 'class', 'git', 'push']],
    ['sudo', ['--user=root', '--user', 'root', '--chdir', '/', '--other-user', 'root', 'git', 'push']],
    ['sudo', ['--login', 'git', 'push']],
    ['sudo', ['--login-class', 'class', 'git', 'push']],
    ['sudo', ['--preserve-env', '--preserve-env=PATH', 'git', 'push']],
    ['sudo', ['-iu', 'root', 'X=1', 'git', 'push']],
    ['sudo', ['--', 'git', 'push']],
    ['doas', ['git', 'push']],
    ['doas', ['-u', 'root', 'git', 'push']],
    ['doas', ['-nu', 'root', 'git', 'push']],
    ['doas', ['-a', 'style', '-C', 'doas.conf', 'git', 'push']],
    ['env', ['-i', '-u', 'HOME', 'X=1', 'git', 'push']],
    ['nice', ['-n', '5', 'git', 'push']],
    ['nohup', ['git', 'push']],
    ['timeout', ['-s', 'KILL', '-k', '1', '--foreground', '5', 'git', 'push']],
    ['time', ['-p', 'git', 'push']],
    ['stdbuf', ['-i0', '-o', 'L', '-e', '0', 'git', 'push']],
    ['ionice', ['-c', '2', '-n', '7', 'git', 'push']],
    ['chrt', ['-f', '-r', '-o', '-b', '-i', '0', 'git', 'push']],
    ['command', ['-p', 'git', 'push']],
    ['builtin', ['git', 'push']],
    ['exec', ['-a', 'name', 'git', 'push']],
    ['sudo', ['env', 'X=1', 'nice', 'git', 'push']],
  ])('reads %s %j as running git push', (command, args) => {
    expect(runs(command, args)).toEqual(['git', 'push'])
  })

  it('reads every wrapper in a nested chain as a command of its own', () => {
    expect(commandForms('sudo', ['-u', 'root', 'env', 'X=1', 'nice', '-n', '5', 'git', 'push']).chain).toEqual([
      ['sudo', '-u', 'root', 'env', 'X=1', 'nice', '-n', '5', 'git', 'push'], ['env', 'X=1', 'nice', '-n', '5', 'git', 'push'], ['nice', '-n', '5', 'git', 'push'], ['git', 'push'],
    ])
  })

  it.each<[string, string[]]>([
    ['sudo', ['-i']],
    ['sudo', ['-s']],
    ['sudo', ['-iu', 'root']],
    ['sudo', ['--login']],
    ['sudo', ['--shell']],
    ['sudo', ['-i', 'X=1']],
    ['doas', ['-s']],
    ['doas', ['-u', 'root', '-s']],
    ['ssh', ['host']],
    ['ssh', ['-p', '22', 'host']],
    ['ssh', ['host', '']],
    ['su', []],
    ['su', ['-']],
    ['su', ['-', 'root']],
    ['su', ['-l', '-g', 'wheel', 'root']],
    ['env', ['ssh', 'host']],
    ['sudo', ['su']],
  ])('reads %s %j as an interactive session, an unread call', (command, args) => {
    expect(readLimitOf(commandForms(command, args))).toBe('session')
  })

  it.each<[string, string[]]>([
    ['sudo', []],
    ['sudo', ['-u', 'root']],
    ['sudo', ['-v']],
    ['sudo', ['-l']],
    ['doas', ['-L']],
    ['ssh', []],
    ['ssh', ['-V']],
    ['ssh', ['-N', '-L', '8080:localhost:80', 'host']],
    ['ssh', ['-G', 'host']],
    ['ssh', ['-W', 'h:22', 'host']],
    ['su', ['--help']],
    ['su', ['-V']],
  ])('reads %s %j as no session: it prints, forwards, or runs nothing', (command, args) => {
    expect(readLimitOf(commandForms(command, args))).toBeNull()
  })
})

// ssh sends the words after its host joined with spaces, which the remote shell parses as shell text; OpenSSH reads
// options before the host and again after it (real ssh -G: `ssh host -l bob` logs in as bob, `ssh host cmd -l bob`
// does not), and runs a ProxyCommand here even with no remote command (real ssh, slice 7j probes).
describe('sshInvocation', () => {
  it.each<[string[], string[], string[], boolean]>([
    [['host'], [], [], true],
    [['host', 'git', 'push'], ['git push'], [], false],
    [['-p', '22', 'host', 'git', 'push'], ['git push'], [], false],
    [['-p22', '-l', 'me', 'host', 'git', 'push'], ['git push'], [], false],
    [['host', '-p', '22', 'git', 'push'], ['git push'], [], false],
    [['host', 'git', '-p', '22'], ['git -p 22'], [], false],
    [['--', 'host', '-l', 'bob'], ['-l bob'], [], false],
    [['-l', 'amy', 'host', '--', '-x'], ['-x'], [], false],
    [['-P', 'tag', '-I', 'lib', '-46tTx', 'host', 'ls'], ['ls'], [], false],
    [['-b', 'a', '-c', 'c', '-e', 'e', '-i', 'i', '-m', 'm', '-B', 'b', '-D', 'd', '-E', 'e', '-F', 'f', '-J', 'j', '-L', 'l', '-R', 'r', '-S', 's', '-w', 'w', 'host', 'ls'], ['ls'], [], false],
    [['host', "git push; rm -rf build"], ['git push; rm -rf build'], [], false],
    [['host', 'git', "'a b'"], ["git 'a b'"], [], false],
    [['host', ''], [], [], true],
    [['-o', 'ProxyCommand=git push', 'host'], [], ['git push'], true],
    [['-oProxyCommand git push', 'host', 'ls'], ['ls'], ['git push'], false],
    [['-o', 'proxycommand = nc %h %p', '-o', 'LocalCommand=git push', '-o', 'KnownHostsCommand=id', 'host', 'ls'], ['ls'], ['nc %h %p', 'git push', 'id'], false],
    [['-o', 'RemoteCommand=git push', 'host'], ['git push'], [], false],
    [['-o', 'User=me', 'host'], [], [], true],
    [['-N', '-L', '8080:h:80', 'host'], [], [], false],
    [['-V'], [], [], false],
    [[], [], [], false],
  ])('reads ssh %j: remote %j, here %j, session %s', (args, remote, local, session) => {
    expect(sshInvocation(args)).toMatchObject({ remote, local, session })
  })

  it('keeps the words after the host, before ssh joins them', () => {
    expect(sshInvocation(['-p', '22', 'host', 'git', "'a b'"]).words).toEqual(['git', "'a b'"])
    expect(sshInvocation(['host']).words).toEqual([])
    expect(sshInvocation(['-V']).words).toEqual([])
  })

  it('names the words before the remote command as options, values, and the host, an -o value as one naming what runs', () => {
    expect(sshInvocation(['-p22', '-l', 'me', '-oUser=x', '-o', 'ProxyCommand=y', 'host', '-T', 'ls']).leading).toEqual([
      { word: '-p22', role: 'option', valueAt: 2 },
      { word: '-l', role: 'option', valueAt: null },
      { word: 'me', role: 'value' },
      { word: '-oUser=x', role: 'option', valueAt: 2, runs: true },
      { word: '-o', role: 'option', valueAt: null, runs: true },
      { word: 'ProxyCommand=y', role: 'value', runs: true },
      { word: 'host', role: 'operand' },
      { word: '-T', role: 'option', valueAt: null },
    ])
  })
})

// Slice 7l: an -o setting read as OpenSSH 9.6's configuration reader reads it (real ssh ran each command shape).
describe('sshCommandSetting', () => {
  it.each<[string, { keyword: string; command: string } | null]>([
    ['ProxyCommand=git push', { keyword: 'proxycommand', command: 'git push' }],
    ['"ProxyCommand" git push', { keyword: 'proxycommand', command: 'git push' }],
    ['"ProxyCommand"=git push', { keyword: 'proxycommand', command: 'git push' }],
    ['Proxy"Command" git push', { keyword: 'proxycommand', command: 'git push' }],
    ['"" ProxyCommand git push', { keyword: 'proxycommand', command: 'git push' }],
    ['ProxyCommand==git push', { keyword: 'proxycommand', command: 'git push' }],
    ['ProxyCommand = = git push', { keyword: 'proxycommand', command: 'git push' }],
    ['  ProxyCommand git push', { keyword: 'proxycommand', command: 'git push' }],
    ['PROXYCOMMAND\tgit push \f', { keyword: 'proxycommand', command: 'git push' }],
    ['"RemoteCommand" id', { keyword: 'remotecommand', command: 'id' }],
    ['User=me', null],
    ['#ProxyCommand git push', null],
    ['"ProxyCommand git push', null],
    ['"" "" ProxyCommand git push', null],
  ])('reads -o %j as %j', (value, setting) => {
    expect(sshCommandSetting(value)).toEqual(setting)
  })

  it('marks a % token other than %% in a command setting, and reads %% as %', () => {
    expect(sshInvocation(['-l', 'git', '-o', 'ProxyCommand=%r push', 'host', 'true'])).toMatchObject({ local: ['%r push'], tokens: true })
    expect(sshInvocation(['-o', 'ProxyCommand=git push %%r', 'host', 'true'])).toMatchObject({ local: ['git push %r'], tokens: false })
    expect(sshInvocation(['-o', 'ProxyCommand=a %%%p', 'host', 'true']).tokens).toBe(true)
    expect(sshInvocation(['-o', 'User=%r', 'host', 'true']).tokens).toBe(false)
  })
})

// Slice 7l: an env -S value with no backslash and no `${`, split as GNU env 9.4 splits it (real env ran each shape).
describe('envSplitWords', () => {
  it.each<[string, string[]]>([
    ['git push', ['git', 'push']],
    ['git\vpush\fmain\rx', ['git', 'push', 'main', 'x']],
    ["git 'a b' \"c d\"", ['git', 'a b', 'c d']],
    ['git push #x y', ['git', 'push']],
    ['git push#x', ['git', 'push#x']],
    ["git '' push", ['git', '', 'push']],
    ['#git push', []],
    ['git\xa0push', ['git\xa0push']],
  ])('splits %j as %j', (value, words) => {
    expect(envSplitWords(value)).toEqual(words)
  })
})

// util-linux su permutes its options, so -c may follow the user; the words after the user go to the shell.
describe('suInvocation', () => {
  it.each<[string[], string | null, string[], string[], boolean]>([
    [[], null, [], [], true],
    [['-'], null, [], [], true],
    [['-', 'root'], null, [], [], true],
    [['--login', 'root'], null, [], [], true],
    [['-g', 'wheel', 'root'], null, [], [], true],
    [['-c', 'git push', 'root'], null, ['git push'], [], false],
    [['root', '-c', 'git push'], null, ['git push'], [], false],
    [['-', 'root', '-c', 'git push'], null, ['git push'], [], false],
    [['-lc', 'git push', 'root'], null, ['git push'], [], false],
    [['-cgit push', 'root'], null, ['git push'], [], false],
    [['--command=git push', 'root'], null, ['git push'], [], false],
    [['--command', 'git push', 'root'], null, ['git push'], [], false],
    [['--com', 'git push', 'root'], null, ['git push'], [], false],
    [['--session-command', 'git push', 'root'], null, ['git push'], [], false],
    [['-c', 'id', '-c', 'git push', 'root'], null, ['id', 'git push'], [], false],
    [['-s', '/bin/zsh', '-c', 'git push', 'root'], '/bin/zsh', ['git push'], [], false],
    [['--shell=python3', 'root', '-c', 'x'], 'python3', ['x'], [], false],
    [['-m', '-p', '-f', '-P', '-G', 'wheel', '-w', 'PATH', '-c', 'git push', 'root'], null, ['git push'], [], false],
    [['root', '--', '-c', 'git push'], null, [], ['-c', 'git push'], false],
    [['root', 'deploy.sh', 'arg'], null, [], ['deploy.sh', 'arg'], false],
    [['--help'], null, [], [], false],
    [['-V'], null, [], [], false],
  ])('reads su %j: shell %s, commands %j, operands %j, session %s', (args, shell, commands, operands, session) => {
    expect(suInvocation(args)).toMatchObject({ shell, commands, operands, session })
  })

  it('reads the shell su runs as a command of its own, with each -c string or with the words after the user', () => {
    expect(commandForms('su', ['-c', 'git push --force', 'root']).nested).toEqual([['sh', '-c', 'git push --force'], ['git', 'push', '--force']])
    expect(commandForms('su', ['-s', '/usr/bin/python3', 'root', '-c', 'import os']).interpreters).toEqual(['python3'])
    expect(commandForms('su', ['root', '--', '-c', 'git push']).nested).toContainEqual(['git', 'push'])
  })

  it('names every word before a -- as an option, a value, or an operand, the -c string and the -s shell as ones naming what runs', () => {
    expect(suInvocation(['-', 'root', '-gwheel', '-s', 'bash', '--command=id', 'x', '--', 'y']).leading).toEqual([
      { word: '-', role: 'operand' },
      { word: 'root', role: 'operand' },
      { word: '-gwheel', role: 'option', valueAt: 2 },
      { word: '-s', role: 'option', valueAt: null },
      { word: 'bash', role: 'value', runs: true },
      { word: '--command=id', role: 'option', valueAt: 10, runs: true },
      { word: 'x', role: 'operand' },
    ])
  })
})
