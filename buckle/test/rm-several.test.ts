import { describe, expect, it } from 'vitest'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'

// A plain rm on the shell side (the fs-verbs brief): a glob in a target, or two targets or more, asks at the destructive
// floor; rm of exactly one literal path does not.

const engine = createPermissionEngine([createDestructiveCommandRule()])
const exec = (command: string, args: string[]): ResolvedEffect => ({ kind: 'exec', command, args })
const evaluate = (effect: ResolvedEffect) => engine.evaluate({ tool: 'shell_exec', effects: [effect], grants: { subjectsFor: () => [] } })

describe('a plain rm', () => {
  it.each([
    ['a glob star', ['*.log']],
    ['a question mark', ['report-?.txt']],
    ['a bracket', ['build[12]']],
    ['two targets', ['a.txt', 'b.txt']],
    ['two targets after --', ['--', 'a.txt', 'b.txt']],
    ['an interactive flag and two targets', ['-i', 'a.txt', 'b.txt']],
  ])('asks at the floor for %s', (_name, args) => {
    expect(evaluate(exec('rm', args))).toMatchObject({ kind: 'ask', asks: [{ rule: 'destructive_command', reason: 'Delete of several files', offeredScopes: ['once', 'session'], cause: 'floor' }] })
  })

  it('asks for a glob in a shell body, as the floor reads each statement', () => {
    expect(evaluate(exec('bash', ['-c', 'cd logs && rm *.log']))).toMatchObject({ kind: 'ask', asks: [{ reason: 'Delete of several files' }] })
  })

  it.each([['one literal path', ['notes.txt']], ['one path after --', ['--', '-odd-name.txt']], ['one path in a folder', ['build/out.js']]])('does not ask for %s', (_name, args) => {
    expect(evaluate(exec('rm', args)).kind).toBe('allow')
  })

  it('keeps the reasons it had for -r and -f', () => {
    expect(evaluate(exec('rm', ['-rf', 'a', 'b']))).toMatchObject({ kind: 'ask', asks: [{ reason: 'Recursive delete' }] })
    expect(evaluate(exec('rm', ['-f', 'a']))).toMatchObject({ kind: 'ask', asks: [{ reason: 'Forced delete' }] })
  })
})
