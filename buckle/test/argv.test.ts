import { describe, expect, it } from 'vitest'
import { argvIdentity, commandSubject, gitInvocation, hasFlag, parseArgv, shellStatementList, shellTokens, shownCommand, statementPieces } from '../common/domain/argv.js'

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

  it('redacts a credential in the display but keeps two different credentials apart', () => {
    const first = commandSubject('git', ['push', '--force', 'https://bot:tok-first@github.com/org/repo.git', 'main'])
    const second = commandSubject('git', ['push', '--force', 'https://bot:tok-second@github.com/org/repo.git', 'main'])
    expect(first).not.toBe(second)
    for (const subject of [first, second]) {
      expect(subject).not.toMatch(/tok-(first|second)/)
      expect(subject).toMatch(/^git push --force 'https:\/\/\[redacted\]@github.com\/org\/repo.git' main  # argv sha256 [a-f0-9]{64}$/)
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
    expect(statements('bash <<-EOF\n\tgit push \\\n\t--force origin main\n\tEOF')).toEqual(['bash <<-EOF', 'git push \\', '--force origin main', 'git push --force origin main'])
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
