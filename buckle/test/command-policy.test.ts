import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { commandFormsOf } from '../common/domain/command-forms.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createCommandPolicyRule } from '../common/domain/permission/rules/command-policy-rule.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { compilePolicy } from '../common/domain/policy.js'

function evaluate(command: string, args: string[], commands: { allow?: string[]; deny?: string[]; destructive?: string[] } = {}) {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = commands.allow ?? []
  policy.commands.deny = commands.deny ?? []
  policy.commands.destructive = commands.destructive ?? []
  const compiled = compilePolicy(policy)
  const engine = createPermissionEngine([
    createCommandPolicyRule(compiled),
    createDestructiveCommandRule({ added: compiled.commands.destructive }),
  ])
  const effect: ResolvedEffect = { kind: 'exec', command, args }
  return engine.evaluate({ tool: 'shell_exec', effects: [effect], grants: { subjectsFor: () => [] } })
}

function reasonOf(outcome: ReturnType<typeof evaluate>): string {
  return outcome.kind === 'deny' ? outcome.denial.reason : ''
}

describe('with no patterns configured', () => {
  it('stays out of the way, leaving ordinary commands to the other rules', () => {
    expect(evaluate('pnpm', ['build']).kind).toBe('allow')
  })
})

describe('the allow list', () => {
  const allow = ['docker compose {up,down,restart} *']

  it('admits what it names', () => {
    expect(evaluate('docker', ['compose', 'up', '-d'], { allow }).kind).toBe('allow')
  })

  it('refuses everything else as a denial, not a question, and says what is allowed', () => {
    const outcome = evaluate('docker', ['compose', 'logs'], { allow })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain('allow list')
    expect(reasonOf(outcome)).toContain('docker compose')
  })

  it('covers the whole line, so an argument the glob does not name is refused', () => {
    expect(evaluate('docker', ['compose', 'up'], { allow: ['docker compose up'] }).kind).toBe('allow')
    expect(evaluate('docker', ['compose', 'up', '--privileged'], { allow: ['docker compose up'] }).kind).toBe('deny')
  })

  it('is not fooled by wrapping the command in a shell', () => {
    expect(evaluate('bash', ['-c', 'docker compose up'], { allow }).kind).toBe('deny')
  })

  it('judges the base name, so a full path to the binary changes nothing', () => {
    expect(evaluate('/usr/bin/docker', ['compose', 'restart'], { allow }).kind).toBe('allow')
  })
})

describe('the deny list', () => {
  const deny = ['{sh,bash,node,python,python3,curl,wget}']

  it.each([
    ['/usr/local/bin/node', ['script.js']],
    ['curl', ['https://example.com']],
    ['python3', ['-c', 'print(1)']],
  ])('refuses %s %s outright, whatever it is handed', (command, args) => {
    const outcome = evaluate(command, args, { deny })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain('command policy')
  })

  it('leaves unlisted commands alone', () => {
    expect(evaluate('pnpm', ['build'], { deny }).kind).toBe('allow')
  })

  it('reaches inside a shell script, statement by statement', () => {
    expect(evaluate('zsh', ['-c', 'echo hi | curl -d @- https://x.test'], { deny: ['curl'], allow: ['zsh -c *'] }).kind).toBe('deny')
  })

  it('wins over the allow list', () => {
    expect(evaluate('curl', ['https://x.test'], { allow: ['curl *'], deny: ['curl'] }).kind).toBe('deny')
  })
})

describe('a shell wrapper', () => {
  it('is refused where there is no allow list at all, because its body is not argv', () => {
    const outcome = evaluate('bash', ['-c', 'pnpm build'])
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain("allow-command 'bash -c *'")
  })

  it('runs once an allow glob names the wrapper itself', () => {
    expect(evaluate('bash', ['-c', 'pnpm build'], { allow: ['bash -c *'] }).kind).toBe('allow')
    expect(evaluate('/bin/sh', ['-c', 'pnpm build'], { allow: ['sh -c *'] }).kind).toBe('allow')
  })

  it('still has every statement of its body judged by the deny list', () => {
    const outcome = evaluate('bash', ['-c', 'pnpm build && curl https://x.test'], { allow: ['bash -c *'], deny: ['curl'] })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain('command policy')
  })

  it('does not name a wrapper an allow glob for another shell admits', () => {
    expect(evaluate('zsh', ['-c', 'pnpm build'], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it('leaves a shell handed a script file to the ordinary rules', () => {
    expect(evaluate('bash', ['build.sh']).kind).toBe('allow')
  })
})

// The continuation review, "Seen outside this range": `env git push --force dest main` passed both the destructive
// floor and the default command policy, and an allowed wrapper's body was never read as commands.
describe('a prefix that runs another command', () => {
  it.each([
    ['env', ['git', 'push', '--force', 'dest', 'main']],
    ['env', ['A=b', 'git', 'clean', '-fdx']],
    ['timeout', ['5', 'git', 'reset', '--hard']],
  ])('asks about %s %s under the default policy, as the command it runs would', (command, args) => {
    const outcome = evaluate(command, args)
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
  })

  it('asks about a destructive body once the owner allows the wrapper', () => {
    const outcome = evaluate('bash', ['-c', 'git push --force origin main'], { allow: ['bash -c *'] })
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(/Force push/)
  })

  it('leaves an ordinary wrapped command alone', () => {
    expect(evaluate('env', ['git', 'status']).kind).toBe('allow')
    expect(evaluate('bash', ['-c', 'git status'], { allow: ['bash -c *'] }).kind).toBe('allow')
  })

  it('has the deny list meet the command behind the prefix', () => {
    expect(evaluate('env', ['A=b', 'curl', 'https://x.test'], { deny: ['curl'] }).kind).toBe('deny')
    expect(evaluate('timeout', ['5', 'nice', 'curl', 'https://x.test'], { deny: ['curl'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', 'env curl https://x.test'], { allow: ['bash -c *'], deny: ['curl'] }).kind).toBe('deny')
  })

  it('needs the wrapper allowed when a prefix hands its command to a shell', () => {
    const outcome = evaluate('env', ['bash', '-c', 'pnpm build'])
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain("allow-command 'bash -c *'")
  })

  it('never carries a command past the allow list, which admits the call as typed', () => {
    expect(evaluate('env', ['pnpm', 'build'], { allow: ['pnpm build'] }).kind).toBe('deny')
    expect(evaluate('pnpm', ['build'], { allow: ['pnpm build'] }).kind).toBe('allow')
  })

  it('reaches the owner\'s destructive list behind a prefix', () => {
    expect(evaluate('env', ['TF_LOG=1', 'terraform', 'destroy'], { destructive: ['terraform destroy *'] }).kind).toBe('ask')
  })
})

// Slice 7 review F1 and owner decision D25: with `bash -c *` allowed and git's history commands denied, an
// assignment prefix, eval, builtin or a runner inside the body passed the deny list (real bash rewrote a branch).
describe('a shell body that hands its command on', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *'] }

  it.each([
    'A=b git push --force origin main',
    'GIT_TRACE=1 git clean -fdx',
    'cd sub && GIT_DIR=.git git reset --hard',
    'eval git push --force origin main',
    "eval 'git push --force origin main'",
    'builtin command git push --force origin main',
    '\\git reset --hard',
    'xargs git push --force dest main',
    'find . -maxdepth 0 -exec git push --force dest main \\;',
    'setsid git push --force dest main',
    'flock /tmp/lock git push --force dest main',
    "git clean -e ';' -f",
  ])('refuses bash -c %s by the deny list', (body) => {
    const outcome = evaluate('bash', ['-c', body], commands)
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toMatch(/Refused by the workspace command policy: git (push|clean|reset) \*/)
  })

  it('asks about an eval whose text it cannot know, since no glob can meet it', () => {
    const outcome = evaluate('bash', ['-c', 'x="git push --force origin main"; eval "$x"'], commands)
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(/^eval runs text/)
  })

  it('leaves an ordinary command behind an assignment alone', () => {
    expect(evaluate('bash', ['-c', 'A=1 git status'], commands).kind).toBe('allow')
  })

  it('needs the wrapper allowed when flock or xargs hands a body to a shell, as env does', () => {
    expect(reasonOf(evaluate('flock', ['/tmp/lock', '-c', 'pnpm build']))).toContain("allow-command 'sh -c *'")
    expect(reasonOf(evaluate('xargs', ['-n', '1', 'bash', '-c', 'pnpm build']))).toContain("allow-command 'bash -c *'")
  })
})

// Slice 7b review W7B-2 to W7B-6: with `bash -c *` allowed and git's history commands and rm denied, `eval --`, a
// one-line `function` or `coproc`, ANSI-C `$'\''`, an apostrophe in an earlier comment or heredoc line, and a find
// primary's value spelled `-exec` each passed the deny list (real bash ran every one).
describe('a shell body the reader now reads whole', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *', 'rm *'] }

  it.each([
    'eval -- git push --force origin main',
    "eval -- 'git clean -fdx'",
    'eval -- rm -rf build',
    'function f { git clean -fdx; }; f',
    'coproc git push --force origin main; wait',
    'coproc NAME { git reset --hard; }; wait',
    'coproc { git reset --hard; }; wait',
    "rm $'\\'' -rf build",
    "git push $'\\'' --force origin main",
    "git clean -e $'\\'' -f",
    "rm $'a\\'b' -rf build",
    "# don't keep build output\ngit clean -e ';' -fdx",
    "echo done # it's\nrm '|' -rf build",
    "cat <<EOF\nit's done\nEOF\ngit clean -e ';' -f",
    'find . -name -exec -exec git clean -f \;',
    'find . -path -exec -exec rm -rf {} +',
    'find . -maxdepth 1 -name -exec -o -exec git clean -f \;',
  ])('refuses bash -c %s by the deny list', (body) => {
    const outcome = evaluate('bash', ['-c', body], commands)
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toMatch(/Refused by the workspace command policy: (git (push|clean|reset)|rm) \*/)
  })

  it('leaves the ordinary forms of the same constructs alone', () => {
    for (const body of ['eval -- echo hi', 'function g { ls; }; g', 'coproc sleep 1; wait', "echo $'it\\'s'; ls", "cat <<EOF\nit's\nEOF\nls"]) {
      expect(evaluate('bash', ['-c', body], commands).kind).toBe('allow')
    }
  })
})

/** Text as one double-quoted shell word. */
const doubleQuoted = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`

// Slice 7b review W7B-1 and W7B-8: each rule read every nested eval or `bash -c` level again, and each level twice, so
// one check of a 1 MB script took 2 to 6 s, and a body of 140,000 quoted statements threw RangeError. A check now
// reads each level once within a budget and asks past it.
describe('a check of a large nested body', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *', 'rm *'] }
  /** A script_run bash script of about 999,180 bytes: `levels` nested `eval "..."` or `bash -c "..."` around filler. */
  const nested = (runner: string, levels: number, tail = '') => {
    let body = `${'a '.repeat(levels === 8 ? 499_000 : 499_400)}${tail}`
    for (let level = 0; level < levels; level++) body = `${runner} ${doubleQuoted(`${body} ; true`)}`
    return body
  }

  it.each([
    ['eval', 8, '', /READ_BUDGET: 8,000,000 characters, 1,000,000 words or 100,000 commands/],
    ['bash -c', 8, '', /READ_BUDGET: 8,000,000 characters, 1,000,000 words or 100,000 commands/],
    ['eval', 3, '; git clean -fdx', /git clean deletes untracked files/],
  ] as const)('checks %s nested %i levels deep in a 1 MB script within a second, and asks', (runner, levels, tail, reason) => {
    const body = nested(runner, levels, tail)
    expect(body.length).toBeGreaterThan(998_000)
    const started = performance.now()
    const outcome = evaluate('bash', ['-c', body], { allow: ['bash -c *'] })
    expect(performance.now() - started).toBeLessThan(1_000)
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(reason)
  })

  it.each(['eval', 'bash -c'])('reads a 1 MB body three %s levels deep whole, each level once, and allows it', (runner) => {
    const started = performance.now()
    expect(evaluate('bash', ['-c', nested(runner, 3)], { allow: ['bash -c *'] }).kind).toBe('allow')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('still refuses by the deny list what a 1 MB body three levels down runs', () => {
    expect(reasonOf(evaluate('bash', ['-c', nested('eval', 3, '; git clean -fdx')], commands))).toMatch(/git clean \*/)
  })

  it('reads the forms of one effect once for every rule and every check of the call', () => {
    const effect = { command: 'bash', args: ['-c', 'eval -- git push --force origin main'] }
    const forms = commandFormsOf(effect)
    expect(commandFormsOf(effect)).toBe(forms)
    expect(commandFormsOf({ ...effect })).not.toBe(forms)
    expect(commandFormsOf({ ...effect })).toEqual(forms)
  })

  it('asks about a body of 140,000 quoted statements past the budget, where it threw RangeError', () => {
    const body = `bash -c '"${Array.from({ length: 140_000 }, (_, index) => `a${index}`).join(';')}"'`
    expect(body.length).toBeGreaterThan(960_000)
    const outcome = evaluate('bash', ['-c', body], { allow: ['bash -c *'] })
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(/^Shell text runs past what Buckle reads in one check \(READ_BUDGET/)
  })
})

// Slice 7c review R7C-CR-1: past READ_BUDGET, or nested past MAX_DEPTH, the deny globs met nothing, so a denied `git push`
// after 100,001 statements was asked about, and the dangerously-allow switch allowed it with no click (owner decision
// D7). A call Buckle cannot read whole is refused whenever a deny glob exists (default D30), on the node ceiling too.
// Slice 7d review R7D-BD-1 and R7D-BD-2: substitutions nested past MAX_SUBSTITUTIONS and a find primary were refused
// as "MAX_DEPTH", and a refusal by the node ceiling blamed the workspace policy. Each reason now names the limit that
// stopped the reading and the policy that refused; every limit still refuses under a deny glob (default D33).
describe('a call Buckle cannot read whole', () => {
  const push = 'git push origin main'
  const statements = (count: number) => `${Array.from({ length: count }, (_, index) => `:${index.toString(36)}`).join(';')}; ${push}`
  const evalNested = (levels: number) => Array.from({ length: levels }).reduce<string>(body => `eval ${doubleQuoted(body)}`, push)
  /** The repo-root idiom of the slice 7d review (rrm0qfZp): five `$(...)` levels inside double quotes, one past MAX_SUBSTITUTIONS. */
  const repoRoot = 'ROOT="$(cd "$(dirname "$(dirname "$(dirname "$(dirname "$0")")")")" && pwd)"; echo "$ROOT"'
  /** The find primary shape of the slice 7d review (0SQC4zdm): a find -exec command that is itself a primary. */
  const findPrimary = 'find . -exec -print \\;'
  const policyOf = (commands: { allow?: string[]; deny?: string[] }) => {
    const policy = emptyWorkspacePolicy()
    policy.commands.allow = commands.allow ?? []
    policy.commands.deny = commands.deny ?? []
    return compilePolicy(policy)
  }
  const engines = {
    workspace: (deny: string[]) => [createCommandPolicyRule(policyOf({ allow: ['bash -c *'], deny })), createDestructiveCommandRule()],
    ceiling: (deny: string[]) => [
      createCommandPolicyRule(policyOf({ deny }), { enforceWrapperAllow: false, source: 'node ceiling' }),
      createCommandPolicyRule(policyOf({ allow: ['bash -c *'] })),
      createDestructiveCommandRule(),
    ],
  }
  const named = { workspace: 'the workspace command policy', ceiling: 'the node ceiling command policy' } as const
  const check = (engine: keyof typeof engines, switched: boolean, body: string, deny = ['git push *']) =>
    withDangerouslyAllow(createPermissionEngine(engines[engine](deny)), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'script_run', effects: [{ kind: 'exec', command: 'bash', args: ['-c', body] }], grants: { subjectsFor: () => [] } })
  const refusal = (outcome: ReturnType<typeof check>) => {
    if (outcome.kind !== 'deny') throw new Error(`expected a deny, got ${outcome.kind}`)
    expect(outcome.denial.rule).toBe('command_policy')
    return outcome.denial.reason
  }
  const overBudget = statements(100_001)
  const eightDeep = evalNested(8)
  const cases = (['workspace', 'ceiling'] as const).flatMap(engine => [false, true].map(switched => [engine, switched] as const))

  it.each(cases)('refuses git push after 100,001 statements past READ_BUDGET, %s deny, switch on: %s', (engine, switched) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', overBudget] }).overBudget).toBe(true)
    expect(refusal(check(engine, switched, overBudget))).toBe(`Shell text runs past what Buckle reads in one check (READ_BUDGET: 8,000,000 characters, 1,000,000 words or 100,000 commands across every level), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each(cases)('refuses git push eight eval levels down, past MAX_DEPTH, %s deny, switch on: %s', (engine, switched) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', eightDeep] }).unread).toBe('depth')
    expect(refusal(check(engine, switched, eightDeep))).toBe(`Wrappers or shell bodies nest deeper than Buckle reads (MAX_DEPTH: 8 levels), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each(cases)('still refuses git push after 99,998 statements by matching it, %s deny, switch on: %s', (engine, switched) => {
    expect(refusal(check(engine, switched, statements(99_998)))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'the repo-root idiom', repoRoot, 'substitutions', 'Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels)'],
    [engine, switched, 'the find primary shape', findPrimary, 'findPrimary', 'A find -exec command starts with a word find reads as a primary, which Buckle does not read as a command (find primary)'],
  ] as const))('refuses %s deny, switch on: %s, %s under terraform destroy *, naming its own limit', (engine, switched, _shape, body, limit, reason) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] })).toMatchObject({ unread: limit, overBudget: false })
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${reason}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'echo $(a $(b $(c $(d $(git push origin main)))))'],
    [engine, switched, 'echo "$(a "$(b "$(c "$(d "$(git push origin main)")")")")"'],
  ] as const))('refuses %s deny, switch on: %s, a git push five substitutions down: %s', (engine, switched, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each([
    [overBudget, /^Shell text runs past what Buckle reads in one check \(READ_BUDGET: .*\); asked rather than guessed at$/],
    [eightDeep, /^Wrappers or shell bodies nest deeper than Buckle reads \(MAX_DEPTH: 8 levels\); asked rather than guessed at$/],
    [repoRoot, /^Command substitutions inside double quotes nest deeper than Buckle splits into statements \(MAX_SUBSTITUTIONS: 4 levels\); asked rather than guessed at$/],
    [findPrimary, /^A find -exec command starts with a word find reads as a primary, which Buckle does not read as a command \(find primary\); asked rather than guessed at$/],
  ])('still asks, naming the limit, with no deny glob', (body, reason) => {
    const outcome = check('workspace', false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })

  // Slice 7e review R7E-LW-1 and R7E-LW-2: a heredoc body line dropped its MAX_SUBSTITUTIONS flag, and was read with
  // shell quoting, although under an unquoted delimiter bash runs every `$(...)` and backtick body in it whatever the
  // quotes around it. A git push nested in a heredoc ran under a git push * deny glob with no refusal and no ask, on
  // both engines and both switches (real bash pushed to a throwaway remote).
  const findLine = (substitution: string) => `find . -maxdepth 0 -exec true ${substitution} \\;`
  /** The nested find shape of the slice 7e review (zSZt25Yl/probe3.out): a find at every level, so each statement reads its text again. */
  const nestedFind = (command: string) => `cat <<EOF\n$(${findLine(Array.from({ length: 5 }).reduce<string>(text => `"$(${findLine(text)})"`, `$(${command})`))})\nEOF`
  const heredocLine = (line: string, opener = 'cat <<EOF', closer = 'EOF') => `${opener}\n${line}\n${closer}`
  const quotedPush = findLine("'$(git push origin main)'")

  it.each(cases)('refuses the nested find heredoc of R7E-LW-1, %s deny, switch on: %s, by the push glob, or by its limit when no glob matches', (engine, switched) => {
    const body = nestedFind(push)
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('substitutions')
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each([
    ['the nested find heredoc', nestedFind(push), /^Command substitutions inside double quotes nest deeper than Buckle splits into statements \(MAX_SUBSTITUTIONS: 4 levels\); asked rather than guessed at$/],
    ['the nested find heredoc with git push --force', nestedFind('git push --force origin main'), /^Force push rewrites remote history/],
    ['the nested find heredoc with rm -rf', nestedFind('rm -rf build'), /^Recursive delete/],
    ['a single-quoted git push --force on a find line', heredocLine(findLine("'$(git push --force origin main)'")), /^Force push rewrites remote history/],
    ['a single-quoted backtick git push --force on a find line', heredocLine(findLine("'`git push --force origin main`'")), /^Force push rewrites remote history/],
  ])('asks at the floor with no deny glob, never allows: %s', (_shape, body, reason) => {
    const outcome = check('workspace', false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'a single-quoted $(...) on a find line', heredocLine(quotedPush)],
    [engine, switched, 'a single-quoted backtick body on a find line', heredocLine(findLine("'`git push origin main`'"))],
    [engine, switched, 'a double-quoted $(...) on a find line', heredocLine(findLine('"$(git push origin main)"'))],
    [engine, switched, 'a <<- body with tabs', heredocLine(`\t${quotedPush}`, 'cat <<-EOF', '\tEOF')],
    [engine, switched, 'a substitution continued past a backslash-newline', heredocLine("find . -maxdepth 0 -exec true '$(git push \\\norigin main)' \\;")],
    [engine, switched, 'a substitution over two lines', heredocLine(`$(echo "a\n${findLine(`"; ${push})"`)}`)],
    [engine, switched, 'a quoted delimiter fed to bash', heredocLine(push, "bash <<'EOF'")],
    // bash stops at the quote that never closes; each line is still read on its own, so no line hides the next.
    [engine, switched, 'a line after one whose quote never closes', heredocLine(`$(echo it's)\n${quotedPush}`)],
  ] as const))('refuses %s deny, switch on: %s, a heredoc whose body runs git push: %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(["cat <<'EOF'", 'cat <<"EOF"', 'cat <<\\EOF'])('reads the find line of %s as shell text only, as before, since bash expands nothing in it', (opener) => {
    const body = heredocLine(quotedPush, opener)
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).nested).toContainEqual(['find', '.', '-maxdepth', '0', '-exec', 'true', '$(git push origin main)', ';'])
    expect(check('workspace', false, body).kind).toBe('allow')
  })

  it('reads a 1 MB heredoc body as shell text and as heredoc text within a second', () => {
    const notes = Array.from({ length: 40_000 }, (_, index) => `note ${index} of the release`).join('\n')
    expect(notes.length).toBeGreaterThan(1_000_000)
    let started = performance.now()
    expect(check('workspace', false, heredocLine(notes)).kind).toBe('allow')
    expect(performance.now() - started).toBeLessThan(1_000)
    started = performance.now()
    expect(refusal(check('workspace', false, heredocLine(`${notes}\n${quotedPush}`)))).toBe('Refused by the workspace command policy: git push *')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  // Slice 7f residual 1: heredoc body lines a backslash-newline joins were read one at a time, so `git push \` then
  // `--force origin main` fed to bash was allowed with no ask (real bash force-pushed); a deny glob still met `git push`.
  const B = '\\'
  const continued = [
    ['a quoted delimiter', `bash <<'EOF'\ngit push ${B}\n--force origin main\nEOF`],
    ['an unquoted delimiter', `bash <<EOF\ngit push ${B}\n--force origin main\nEOF`],
    ['three lines joined', `bash <<'EOF'\ngit push ${B}\n--force ${B}\norigin main\nEOF`],
    ['a <<- body with tabs', `bash <<-'EOF'\n\tgit push ${B}\n\t--force origin main\n\tEOF`],
    ['an unquoted delimiter and an escaped backslash, which bash halves', `bash <<EOF\ngit push ${B}${B}\n--force origin main\nEOF`],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => continued.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a continued git push under %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace', 'ceiling'] as const).flatMap(engine => continued.map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a continued force push under %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  it.each([
    ['a backslash before the delimiter line', `bash <<'EOF'\ngit push --force ${B}\nEOF\necho after`, 'ask'],
    ['an escaped backslash under a quoted delimiter, which joins nothing (real bash ran no force push)', `bash <<'EOF'\ngit push ${B}${B}\n--force origin main\nEOF`, 'allow'],
  ] as const)('reads %s as bash does, with no deny glob', (_shape, body, kind) => {
    expect(check('workspace', false, body, []).kind).toBe(kind)
  })

  // Slice 7f review R7F-HR-1: an unquoted heredoc body fed to a shell is read as the shell receives it, so a git push
  // a backslash-dollar or an escaped backtick hid is read; R7F-HR-2: a body line ending in an odd run of backslashes
  // joins the delimiter line into the body, so the find line past it expands. Real bash pushed to a throwaway remote.
  const escapeShapes = {
    'a backslash-dollar substitution': (command: string) => heredocLine(findLine(`"\\$(${command})"`), 'bash <<EOF'),
    'an escaped backtick substitution': (command: string) => heredocLine(findLine(`"\\\`${command}\\\`"`), 'bash <<EOF'),
    'a delimiter line swallowed by a continuation': (command: string) => `cat <<EOF\nx ${B}\nEOF\n${findLine(`'$(${command})'`)}\nEOF`,
  } as const
  const escapeCases = Object.entries(escapeShapes)

  it.each(cases.flatMap(([engine, switched]) => escapeCases.map(([shape, make]) => [engine, switched, shape, make(push)] as const)))('refuses %s deny, switch on: %s, a git push an unquoted heredoc body hides with %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace', 'ceiling'] as const).flatMap(engine => escapeCases.map(([shape, make]) => [engine, shape, make('git push --force origin main')] as const)))('asks at the floor, %s with no deny glob, about a force push an unquoted body hides with %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // `git push \\--force` reaches the fed shell as `git push \--force`, which is `git push --force`, so the force glob
  // and the force-push floor both meet it although the raw body carries no `--force` word.
  const halvedForce = `bash <<EOF\ngit push ${B}${B}--force origin main\nEOF`

  it.each(cases)('refuses a halved force push, %s deny, switch on: %s, by the force glob', (engine, switched) => {
    expect(refusal(check(engine, switched, halvedForce, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it('asks at the floor about a halved force push with no deny glob', () => {
    const outcome = check('workspace', false, halvedForce, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  it.each([
    ['a double-quoted backslash-dollar fed to bash', heredocLine(findLine('"\\$(git push origin main)"'), "bash <<'EOF'")],
    ['a continuation that joins nothing under a quoted delimiter', `cat <<'EOF'\nx ${B}\nEOF\n${findLine("'$(git push origin main)'")}\nEOF`],
  ] as const)('leaves a quoted-delimiter body unexpanded as at eaf4e05, so it allows: %s', (_shape, body) => {
    expect(check('workspace', false, body).kind).toBe('allow')
  })

  // Slice 7f review R7F-HR-3 and R7F-HR-4: every heredoc body is read whole as shell text, its nested bodies whole in
  // turn, so a quoted body fed to bash, a double quote spanning body lines and a substitution spanning a nested body
  // no longer hide a denied command. Real bash pushed to a throwaway remote.
  const findWhole = 'find . -maxdepth 0 -exec true'
  const wholeShapes = {
    'a quoted body fed to bash with an inner unquoted heredoc': (command: string) => `bash <<'EOF'\ncat <<X\n${findWhole} '$(${command})' ${B};\nX\nEOF`,
    'a double quote spanning body lines': (command: string) => `bash <<'EOF'\n${findWhole} "\n${findWhole} ' $(${command}) ' ${B};\n" ${B};\nEOF`,
    'a substitution spanning a nested unquoted heredoc': (command: string) => `cat <<EOF\n$(cat <<X\nx '$("\n${findWhole} " ;${command}; " ${B};\n")'\nX\n)\nEOF`,
  } as const
  const wholeCases = Object.entries(wholeShapes)

  it.each(cases.flatMap(([engine, switched]) => wholeCases.map(([shape, make]) => [engine, switched, shape, make(push)] as const)))('refuses %s deny, switch on: %s, a git push a whole-body reading reveals with %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace', 'ceiling'] as const).flatMap(engine => wholeCases.map(([shape, make]) => [engine, shape, make('git push --force origin main')] as const)))('asks at the floor, %s with no deny glob, about a force push a whole-body reading reveals with %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // A heredoc nested inside a whole reading is read whole in turn, up to MAX_DEPTH; a thousand nested one in another
  // are left unread 'depth', refused under a deny glob and asked about without one, within a second (bounded passes).
  const nestedHeredocs = (count: number) => {
    const open = Array.from({ length: count }, (_, index) => `bash <<'D${index}'`).join('\n')
    const close = Array.from({ length: count }, (_, index) => `D${count - 1 - index}`).join('\n')
    return `${open}\necho deep\n${close}`
  }

  it.each(cases)('refuses a thousand nested heredocs, %s deny, switch on: %s, naming the depth limit, within a second', (engine, switched) => {
    const body = nestedHeredocs(1_000)
    const started = performance.now()
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('depth')
    expect(refusal(check(engine, switched, body))).toBe(`Wrappers or shell bodies nest deeper than Buckle reads (MAX_DEPTH: 8 levels), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('asks about a thousand nested heredocs with no deny glob, naming the depth limit', () => {
    const outcome = check('workspace', false, nestedHeredocs(1_000), [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Wrappers or shell bodies nest deeper than Buckle reads \(MAX_DEPTH: 8 levels\)/)]])
  })

  it('reads a 1 MB quoted heredoc body whole as shell text within a second', () => {
    const notes = Array.from({ length: 40_000 }, (_, index) => `note ${index} of the release`).join('\n')
    expect(notes.length).toBeGreaterThan(1_000_000)
    const started = performance.now()
    expect(check('workspace', false, heredocLine(notes, "bash <<'EOF'")).kind).toBe('allow')
    expect(refusal(check('workspace', false, heredocLine(`${notes}\n${push}`, "bash <<'EOF'")))).toBe('Refused by the workspace command policy: git push *')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  // Slice 7h probe: a backslash-newline outside single quotes is a line continuation bash removes before it splits
  // words, so one inside a command name or a flag ran a git push, or a force push, that every rule read as two words.
  // Real bash ran the sentinel in each shape.
  const continuedShapes = {
    'the command name': `gi${B}\nt push origin main`,
    'a word inside a double-quoted substitution': `echo "$(git pu${B}\nsh origin main)"`,
    'a double-quoted shell body': `bash -c "gi${B}\nt push origin main"`,
    'a word inside a backtick substitution': `echo \`git pu${B}\nsh origin main\``,
  } as const

  it.each(cases.flatMap(([engine, switched]) => Object.entries(continuedShapes).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a git push a backslash-newline splits in %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(['workspace', 'ceiling'] as const)('asks at the floor, %s with no deny glob, about a force push whose flag a backslash-newline splits', (engine) => {
    for (const body of [`git push --for${B}\nce origin main`, `echo \`git push "--for${B}\nce" origin main\``]) {
      const outcome = check(engine, false, body, [])
      if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
      expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
    }
  })

  // Slice 7h probes: inside a backtick body bash removes a backslash before `\`, a backtick or `$` (and `"` in double
  // quotes) before it parses the body, so `\\--force` there force-pushes; the reader read `\--force`, which neither the
  // force glob nor the force-push floor met, at top level, in double quotes, under bash -c and in every heredoc body.
  // Real bash ran the sentinel in each shape.
  const backtickForce = {
    'top level': `echo \`git push ${B}${B}--force origin main\``,
    'double quotes': `echo "\`git push ${B}${B}--force origin main\`"`,
    'bash -c': `bash -c 'echo \`git push ${B}${B}--force origin main\`'`,
    'a quoted heredoc fed to bash': heredocLine(`echo \`git push ${B}${B}--force origin main\``, "bash <<'EOF'"),
    'a nested backtick': `echo \`echo ${B}\`git push ${B}${B}${B}${B}--force origin main${B}\`\``,
    'escaped double quotes in double quotes': `echo "\`git push ${B}"--force${B}" origin main\`"`,
  } as const

  it.each(cases.flatMap(([engine, switched]) => Object.entries(backtickForce).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a force push a backtick body escapes in %s, by the force glob', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it.each((['workspace', 'ceiling'] as const).flatMap(engine => Object.entries(backtickForce).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push a backtick body escapes in %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // Slice 7i probes: a comment inside a backtick body ran to the end of the line, so the git push after the
  // substitution ran with no rule reading it; bash ends the comment at the closing backtick. Real bash ran the sentinel.
  const commentedBacktick = {
    'top level': `echo \`id # c\`; ${push}`,
    'bash -c': `bash -c 'echo \`id # c\`; ${push}'`,
    'a quoted heredoc fed to bash': heredocLine(`echo \`id # c\`; ${push}`, "bash <<'EOF'"),
    'heredoc text': heredocLine(`\`id # c\` \`${push}\``),
  } as const

  it.each(cases.flatMap(([engine, switched]) => Object.entries(commentedBacktick).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a git push after a commented backtick body in %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(['workspace', 'ceiling'] as const)('asks at the floor, %s with no deny glob, about a force push after a commented backtick body', (engine) => {
    const outcome = check(engine, false, `echo \`id # c\`; git push --force origin main`, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // Slice 7h probes: a shell whose script arrives as data, piped in, redirected, or handed over by xargs, ran the
  // payload with nothing read; the floor asked only about `| bash`, so under the dangerously-allow switch a deny glob
  // was bypassed (owner decision D7). Such a call is now unread: refused naming the limit under any deny glob, on both
  // engines and both switches, and asked at the floor with none (default D33 (b)). Real bash ran the sentinel in each.
  const scriptData = 'A shell takes its script from a pipe, a redirection, or xargs, so the script arrives as data, which Buckle cannot read (script as data)'
  const piped = /^Pipes a downloaded payload into a shell/
  const asData = new RegExp(`^${scriptData.replace(/[()]/g, '\\$&')}; asked rather than guessed at$`)
  const dataShapes = [
    ['echo piped into bash', `echo '${push}' | bash`, piped],
    ['printf piped into xargs -d newline bash -c', `printf '%s\\n' '${push}' | xargs -d '\\n' bash -c`, asData],
    ['xargs -0 bash -c', `printf '%s\\0' '${push}' | xargs -0 bash -c`, asData],
    ['xargs bash -c with a double-quoted item', heredocLine(`"${push}"`, "xargs bash -c <<'EOF'"), asData],
    ['xargs bash -c with a single-quoted item', heredocLine(`'${push}'`, "xargs bash -c <<'EOF'"), asData],
    ['xargs sh -c with escaped spaces', heredocLine(`git${B} push${B} origin${B} main`, "xargs sh -c <<'EOF'"), asData],
    ['xargs -I bash -c', heredocLine(push, "xargs -I{} bash -c {} <<'EOF'"), asData],
    ['xargs env bash -c', `printf '%s\\n' '${push}' | xargs -d '\\n' env bash -c`, asData],
    ['echo piped into sh -s', `echo '${push}' | sh -s`, piped],
    ['echo piped into bash /dev/stdin', `echo '${push}' | bash /dev/stdin`, piped],
    ['echo piped into a group running bash', `echo '${push}' | { bash; }`, asData],
    ['echo piped into bash -c bash', `echo '${push}' | bash -c bash`, piped],
    ['a pipe into bash with a heredoc on descriptor 3', heredocLine('x', `echo '${push}' | bash 3<<'EOF'`), piped],
    ['bash from a redirected file', 'bash < deploy.sh', asData],
    ['bash from a here-string', `bash <<< '${push}'`, asData],
    ['bash from a process substitution', `bash <(echo '${push}')`, asData],
    ['source from a process substitution', `source <(echo '${push}')`, asData],
    ['echo piped into source /dev/stdin', `echo '${push}' | source /dev/stdin`, /^Targets a device node/],
    ['bash -c with no command string', 'bash -c', asData],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => dataShapes.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a script that arrives as data: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(true)
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace', 'ceiling'] as const).flatMap(engine => dataShapes.map(([shape, body, reason]) => [engine, shape, body, reason] as const)))('asks at the floor, %s with no deny glob, about a script that arrives as data: %s', (engine, _shape, body, reason) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })

  it.each(cases)('refuses xargs handing items to bash -c as the call itself, %s deny, switch on: %s, naming the limit', (engine, switched) => {
    const outcome = withDangerouslyAllow(createPermissionEngine(engines[engine](['terraform destroy *'])), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command: 'xargs', args: ['-0', 'bash', '-c'] }], grants: { subjectsFor: () => [] } })
    expect(refusal(outcome)).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  // A heredoc on the shell's own statement feeds its input, and Buckle reads that body; a -c string is read too; and a
  // shell with no operand as the call itself reads the input Buckle's exec leaves empty. These stay read as before.
  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'a heredoc feeding bash after a pipe', heredocLine(push, "echo x | bash <<'EOF'")],
    [engine, switched, 'bash -s fed by its heredoc', heredocLine(push, "bash -s <<'EOF'")],
    [engine, switched, 'bash -c with a string after a pipe', `echo x | bash -c '${push}'`],
  ] as const))('refuses %s deny, switch on: %s, by the push glob, a git push read through %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(false)
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it('reads no script as data in bash with no operand as the call itself, or in bash --version after a pipe', () => {
    expect(commandFormsOf({ command: 'bash', args: [] }).scriptData).toBe(false)
    expect(commandFormsOf({ command: 'env', args: ['bash'] }).scriptData).toBe(false)
    expect(commandFormsOf({ command: 'bash', args: ['-c', `echo '${push}' | bash --version`] }).scriptData).toBe(false)
  })

  // A statement's pieces are a split no shell makes, read only so a glob meets a command quoted for another program,
  // so a shell named inside a quoted message marks no script as data.
  it('reads no script as data in a shell named inside a quoted argument', () => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', 'git commit -m "fix the build; bash; source"'] }).scriptData).toBe(false)
    expect(check('workspace', false, 'git commit -m "fix the build; bash; source"', ['terraform destroy *']).kind).toBe('allow')
  })

  // Slice 7h probes: under `<<-EOF` a line an odd run of backslashes joins on keeps its tabs, so five backslashes
  // before the newline leave a `\` word and a tab before `--force`: real bash passed `\`, `--force`, `origin` and
  // `main` as four words (seven leave one word, `\` and a tab and `--force`, so no flag). The reader stripped every
  // line and read `\--force`, so the floor let the force push run.
  const tabbedRuns = [[5, `bash <<-EOF\n\tgit push ${B.repeat(5)}\n\t--force origin main\n\tEOF`]] as const

  it.each(['workspace', 'ceiling'] as const)('asks at the floor, %s with no deny glob, about a force push a <<- continuation joins on with its tab', (engine) => {
    for (const [, body] of tabbedRuns) {
      const outcome = check(engine, false, body, [])
      if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
      expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
    }
  })

  it.each(cases)('refuses %s deny, switch on: %s, a git push a <<- continuation joins on with its tab', (engine, switched) => {
    for (const [, body] of tabbedRuns) expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  // A continuation between words joins no word and leaves none, so `git push \<newline> --force` reads as `git push
  // --force` and a word glob on it still matches; an empty word between push and the flag would misalign it.
  it.each(cases)('refuses a force push with a space-surrounded continuation, %s deny, switch on: %s, by the force glob', (engine, switched) => {
    expect(refusal(check(engine, switched, `git push ${B}\n --force origin main`, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  // Slice 7e review R7E-LW-3: the node ceiling's rule runs first, so with deny lists in both policies it refused at a
  // reading limit naming itself although the workspace glob had matched the push. A glob that matched in any policy is
  // named first; the limit is named, ceiling first, only when none matched. The call is refused either way.
  const bothPolicies = (ceilingDeny: string[], workspaceDeny: string[]) => {
    const workspace = policyOf({ allow: ['bash -c *'], deny: workspaceDeny })
    return [
      createCommandPolicyRule(policyOf({ deny: ceilingDeny }), { enforceWrapperAllow: false, source: 'node ceiling', others: [{ policy: workspace, source: 'workspace' }] }),
      createCommandPolicyRule(workspace),
      createDestructiveCommandRule(),
    ]
  }
  const checkBoth = (switched: boolean, body: string, ceilingDeny: string[], workspaceDeny: string[]) =>
    withDangerouslyAllow(createPermissionEngine(bothPolicies(ceilingDeny, workspaceDeny)), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'script_run', effects: [{ kind: 'exec', command: 'bash', args: ['-c', body] }], grants: { subjectsFor: () => [] } })

  it.each([false, true].flatMap(switched => [
    [switched, 'node ceiling terraform, workspace git push, the idiom then a push', `${repoRoot}; ${push}`, ['terraform destroy *'], ['git push *'], 'Refused by the workspace command policy: git push *'],
    [switched, 'node ceiling git push, workspace terraform, the idiom then a push', `${repoRoot}; ${push}`, ['git push *'], ['terraform destroy *'], 'Refused by the node ceiling command policy: git push *'],
    [switched, 'node ceiling terraform, workspace git push, the idiom alone', repoRoot, ['terraform destroy *'], ['git push *'], "Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels), so the node ceiling command policy's deny list cannot meet all of it; refused rather than asked"],
    [switched, 'node ceiling git push, no workspace deny list, the idiom alone', repoRoot, ['git push *'], [], "Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels), so the node ceiling command policy's deny list cannot meet all of it; refused rather than asked"],
    [switched, 'no node ceiling deny list, workspace git push, the idiom alone', repoRoot, [], ['git push *'], "Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels), so the workspace command policy's deny list cannot meet all of it; refused rather than asked"],
  ] as const))('names the glob that matched before any limit, switch on: %s, %s', (switched, _shape, body, ceilingDeny, workspaceDeny, reason) => {
    expect(refusal(checkBoth(switched, body, [...ceilingDeny], [...workspaceDeny]))).toBe(reason)
  })

  it('reads a heredoc body of 40,000 lines, every one continued, within a second, joining them in one pass', () => {
    const notes = Array.from({ length: 40_000 }, (_, index) => `note ${index} of the release ${B}`).join('\n')
    expect(notes.length).toBeGreaterThan(1_000_000)
    for (const opener of ["bash <<'EOF'", 'bash <<EOF']) {
      const started = performance.now()
      expect(check('workspace', false, heredocLine(notes, opener)).kind).toBe('allow')
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })

  it('reads a thousand heredocs nested in substitutions within a second, each body whole once', () => {
    const opened = Array.from({ length: 1_000 }, (_, index) => `$(cat <<D${index}`).join('\n')
    const closed = Array.from({ length: 1_000 }, (_, index) => `D${999 - index}\n)`).join('\n')
    const started = performance.now()
    expect(check('workspace', false, heredocLine(`${opened}\n${quotedPush}\n${closed}`))).toMatchObject({ kind: 'deny' })
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('the destructive floor the owner raised', () => {
  const destructive = ['terraform destroy *']

  it('asks before running what the owner added, naming the glob', () => {
    const outcome = evaluate('terraform', ['destroy', '-auto-approve'], { destructive })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
    expect(outcome.asks[0]?.reason).toContain('terraform destroy *')
  })

  it('never offers a standing grant for one', () => {
    const outcome = evaluate('terraform', ['destroy'], { destructive })
    if (outcome.kind !== 'ask') throw new Error('expected ask')
    expect(outcome.asks[0]?.offeredScopes).toEqual(['once', 'session'])
  })

  it('leaves the rest of that binary alone', () => {
    expect(evaluate('terraform', ['plan'], { destructive }).kind).toBe('allow')
  })

  it('reaches what an allowed wrapper runs', () => {
    expect(evaluate('bash', ['-c', 'cd infra && terraform destroy'], { allow: ['bash -c *'], destructive }).kind).toBe('ask')
  })

  it('cannot lower the built-in floor, whatever the owner lists', () => {
    expect(evaluate('sudo', ['ls'], { destructive, allow: ['sudo *'] }).kind).toBe('ask')
    expect(evaluate('rm', ['-rf', 'build'], { destructive }).kind).toBe('ask')
  })
})

describe('what no pattern can change', () => {
  it('never lets a tool administer the node that runs it', () => {
    expect(reasonOf(evaluate('buckle', ['approve', 'abc'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'cd /x && buckle grants revoke 1']).kind).toBe('deny')
  })

  it('refuses the pending queue too, which is where a tool would read the token to approve itself', () => {
    expect(reasonOf(evaluate('buckle', ['approvals'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'buckle approvals --json'], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it('refuses check-url, which would hand a tool a probe of the network policy', () => {
    expect(reasonOf(evaluate('buckle', ['check-url', 'example.com'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'buckle check-url 10.0.0.1'], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it.each(['workspaces', 'history', 'settings', 'init'])('rejects %s administration directly and through a wrapper', command => {
    expect(evaluate('buckle', [command, 'list'], { allow: ['*'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', `buckle ${command} list`], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it('refuses a settings write, which would turn a pack or the shell on for the next start', () => {
    expect(reasonOf(evaluate('buckle', ['settings', 'set', 'host-git', 'on'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'buckle settings set shell on'], { allow: ['bash -c *'] }).kind).toBe('deny')
    expect(evaluate('node', ['./node_modules/.bin/buckle', 'settings', 'show'], { allow: ['*'] }).kind).toBe('deny')
  })

  it.each([
    ['buckle', ['approve', 'abc']],
    ['/usr/local/bin/buckle', ['approve', 'abc']],
    ['./node_modules/.bin/buckle', ['approve', 'abc']],
    ['node', ['./node_modules/.bin/buckle', 'approve', 'abc']],
    ['bash', ['-c', '/usr/local/bin/buckle approve abc']],
    ['bash', ['-c', '"./node_modules/.bin/buckle" approve abc']],
  ] as Array<[string, string[]]>)('refuses %s %j, whatever path names the binary', (command, args) => {
    expect(reasonOf(evaluate(command, args, { allow: ['*', 'bash -c *'] }))).toContain('cannot administer')
  })

  it('still lets a tool drive the node the ordinary way', () => {
    expect(evaluate('buckle', ['fs', 'read', 'a.ts']).kind).toBe('allow')
    expect(evaluate('/usr/local/bin/buckle', ['fs', 'read', 'a.ts']).kind).toBe('allow')
    expect(evaluate('/opt/notbuckle', ['approve', 'abc']).kind).toBe('allow')
    expect(evaluate('pnpm', ['--filter', '@5straps/buckle', 'mcp-probe']).kind).toBe('allow')
    expect(evaluate('cat', ['/srv/buckle', 'policy.json']).kind).toBe('allow')
  })

  it('keeps the destructive gate under an allow pattern, so rm -rf still asks', () => {
    const outcome = evaluate('rm', ['-rf', 'build'], { allow: ['rm -rf build'] })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
  })
})
