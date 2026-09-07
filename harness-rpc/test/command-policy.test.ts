import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import type { ResolvedEffect } from '../src/domain/effect.js'
import { createPermissionEngine } from '../src/domain/permission/engine.js'
import { createCommandPolicyRule } from '../src/domain/permission/rules/command-policy-rule.js'
import { createDestructiveCommandRule } from '../src/domain/permission/rules/destructive-command-rule.js'
import { compilePolicy } from '../src/domain/policy.js'

function evaluate(command: string, args: string[], commands: { allow?: string[]; deny?: string[] } = {}) {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = commands.allow ?? []
  policy.commands.deny = commands.deny ?? []
  const engine = createPermissionEngine([createCommandPolicyRule(compilePolicy(policy)), createDestructiveCommandRule()])
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

describe('what no pattern can change', () => {
  it('never lets a tool administer the node that runs it', () => {
    expect(reasonOf(evaluate('buckle', ['approve', 'abc'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'cd /x && buckle grants revoke 1']).kind).toBe('deny')
  })

  it('still lets a tool drive the node the ordinary way', () => {
    expect(evaluate('buckle', ['fs', 'read', 'a.ts']).kind).toBe('allow')
  })

  it('keeps the destructive gate under an allow pattern, so rm -rf still asks', () => {
    const outcome = evaluate('rm', ['-rf', 'build'], { allow: ['rm -rf build'] })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
  })
})
