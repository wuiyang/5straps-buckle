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
    expect(statements("bash <<'EOF'\ngit push \\\n--force \\\norigin main\nEOF")).toEqual(["bash <<'EOF'", 'git push \\', '--force \\', 'origin main', 'git push --force origin main'])
    expect(statements('bash <<-EOF\n\tgit push \\\n\t--force origin main\n\tEOF')).toEqual(['bash <<-EOF', 'git push \\', '--force origin main', 'git push --force origin main'])
    // A run still open at the delimiter line is read as it stands, and the delimiter line still ends the body.
    expect(statements("bash <<'EOF'\ngit push --force \\\nEOF\necho after")).toEqual(["bash <<'EOF'", 'git push --force \\', 'git push --force', 'echo after'])
    // An escaped backslash ends no line under a quoted delimiter; under an unquoted one bash halves it first, so it does.
    expect(statements("bash <<'EOF'\ngit push \\\\\n--force origin main\nEOF")).toEqual(["bash <<'EOF'", 'git push \\\\', '--force origin main'])
    expect(statements('bash <<EOF\ngit push \\\\\n--force origin main\nEOF')).toEqual(['bash <<EOF', 'git push \\\\', '--force origin main', 'git push --force origin main'])
    expect(statements('bash <<EOF\ngit push \\\\\\\\\n--force origin main\nEOF')).toEqual(['bash <<EOF', 'git push \\\\\\\\', '--force origin main'])
  })

  it('says a heredoc body nests substitutions past MAX_SUBSTITUTIONS, whatever its delimiter', () => {
    for (const opener of ['cat <<EOF', "cat <<'EOF'", 'bash <<-EOF']) {
      expect(shellStatementList(`${opener}\necho "$(a "$(b "$(c "$(d "$(git push)")")")")"\nEOF`).deep).toBe(true)
      expect(shellStatementList(`${opener}\necho "$(a "$(b "$(c "$(git push)")")")"\nEOF`).deep).toBe(false)
    }
  })

  it('reads each $(...) or backtick body inside double quotes as statements of its own', () => {
    expect(statementsOf('echo "$(git push -f; ls)" `id`')).toEqual(['git push -f', 'ls', 'echo "$(git push -f; ls)"', 'id', 'echo "', '"'])
  })

  it('keeps a quoted separator inside its statement and still offers the textual split as candidates', () => {
    expect(statementsOf("git clean -e ';' -f && echo ok")).toEqual(["git clean -e ';' -f", 'echo ok', "git clean -e '", "' -f"])
    expect(statementsOf('find . -exec rm {} \x5c; ; ls')).toEqual(['find . -exec rm {} \x5c;', 'ls', 'find . -exec rm {} \x5c'])
  })
})
