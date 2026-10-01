import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { commandFormsOf } from '../common/domain/command-forms.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createCommandPolicyRule } from '../common/domain/permission/rules/command-policy-rule.js'
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

// Slice 7b review W7B-1 and W7B-8: each rule read every nested eval or `bash -c` level again, and each level twice, so
// one check of a 1 MB script took 2 to 6 s, and a body of 140,000 quoted statements threw RangeError. A check now
// reads each level once within a budget and asks past it.
describe('a check of a large nested body', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *', 'rm *'] }
  const doubleQuoted = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
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
