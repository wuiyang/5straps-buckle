import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import type { ResolvedEffect } from '../common/domain/effect.js'
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
