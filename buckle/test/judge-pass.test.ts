import { describe, expect, it } from 'vitest'
import { compileCommandGlob } from '../common/domain/command-glob.js'
import { judgeable, judgePasses, passKey, quickCovers, ratedDanger, withJudged } from '../common/domain/permission/judged.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import type { PermissionDecision } from '../common/domain/permission/decision.js'
import type { JudgeResult } from '../common/types/ports/judge.js'

// Which asks the decision AI may answer, and what passing one does (D91, brief item 2): the destructive floor marks an
// ask about an interpreter the policy does not allow, and nothing else, and a safe verdict at 0.8 or above takes it out.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
const NO_GRANTS = { subjectsFor: () => [] }

function floorAsk(command: string, args: string[], added: string[] = []): Ask {
  const decision = createDestructiveCommandRule({ added: added.map(compileCommandGlob) }).evaluate({ tool: 'shell_exec', effect: { kind: 'exec', command, args }, grants: NO_GRANTS })
  if (decision?.kind !== 'ask') throw new Error(`expected an ask for ${command}`)
  return decision
}

describe('why the destructive floor asks', () => {
  it('marks an unknown interpreter, and nothing that also meets a built-in reason, another reading limit, or the destructive list', () => {
    expect(floorAsk('python3', ['job.py']).cause).toBe('interpreter')
    expect(floorAsk('sudo', ['python3', 'job.py']).cause).toBe('floor')
    expect(floorAsk('rm', ['-rf', 'build']).cause).toBe('floor')
    expect(floorAsk('bash', ['-c', 'eval "$x"']).cause).toBe('floor')
    expect(floorAsk('python3', ['job.py'], ['python3 *']).cause).toBe('destructive-list')
    expect(floorAsk('terraform', ['destroy', 'x'], ['terraform destroy *']).cause).toBe('destructive-list')
    // The reason the approver reads is the one it always was.
    expect(floorAsk('python3', ['job.py'], ['python3 *']).reason).toContain('unknown interpreter')
    expect(judgeable(floorAsk('python3', ['job.py']))).toBe(true)
    expect(judgeable(floorAsk('python3', ['job.py'], ['python3 *']))).toBe(false)
  })
})

describe('what the quick stage\'s scope covers', () => {
  it('interpreters: the interpreter asks alone; asks and all: every destructive floor ask; off: none', () => {
    const interpreter = floorAsk('python3', ['job.py'])
    const floor = floorAsk('sudo', ['ls'])
    const listed = floorAsk('terraform', ['destroy', 'x'], ['terraform destroy *'])
    const flagged: Ask = { ...floor, cause: 'judge' }
    expect([interpreter, floor, listed, flagged].map(ask => quickCovers('interpreters', ask))).toEqual([true, false, false, false])
    expect([interpreter, floor, listed, flagged].map(ask => quickCovers('asks', ask))).toEqual([true, true, true, false])
    expect([interpreter, floor, listed, flagged].map(ask => quickCovers('all', ask))).toEqual([true, true, true, false])
    expect([interpreter, floor, listed, flagged].map(ask => quickCovers('off', ask))).toEqual([false, false, false, false])
  })

  it('takes a danger at 0.8 or above as settled, and nothing less', () => {
    const verdict = (level: 'safe' | 'warning' | 'danger', confidence: number) => ({ kind: 'verdict' as const, level, confidence, probabilities: { safe: 0, warning: 0, danger: 0 }, model: 'jev', latencyMs: 1 })
    expect(ratedDanger(verdict('danger', 0.8))).toBe(true)
    expect(ratedDanger(verdict('danger', 0.79))).toBe(false)
    expect(ratedDanger(verdict('warning', 0.99))).toBe(false)
    expect(judgePasses(verdict('safe', 0.8))).toBe(true)
  })
})

describe('a verdict that passes a call', () => {
  const verdict = (level: 'safe' | 'warning' | 'danger', confidence: number): JudgeResult => ({ kind: 'verdict', level, confidence, reasoning: '', model: 'm', latencyMs: 1, promptDigest: '0'.repeat(64) })

  it('is safe at 0.8 or above, and nothing else', () => {
    expect(judgePasses(verdict('safe', 0.8))).toBe(true)
    expect(judgePasses(verdict('safe', 0.79))).toBe(false)
    expect(judgePasses(verdict('warning', 1))).toBe(false)
    expect(judgePasses({ kind: 'unavailable', reason: 'x' })).toBe(false)
  })

  it('takes out the asks it passed, keeps every other, and allows naming the judge beside the grants once none is left', () => {
    const interpreter = floorAsk('python3', ['job.py'])
    const write: Ask = { kind: 'ask', rule: 'write_scope', subject: '/w', reason: 'write', offeredScopes: ['once'] }
    const outcome = { kind: 'ask' as const, asks: [interpreter, write], allowedBy: ['read_scope:/r'] }
    expect(withJudged(outcome, new Set())).toBe(outcome)
    expect(withJudged(outcome, new Set([passKey(interpreter)]))).toEqual({ kind: 'ask', asks: [write], allowedBy: ['read_scope:/r'] })
    expect(withJudged({ ...outcome, asks: [interpreter] }, new Set([passKey(interpreter)]))).toEqual({ kind: 'allow', allowedBy: ['read_scope:/r', `judge:destructive_command:${interpreter.subject}`] })
    // A subject passed for an interpreter never takes out the same subject's ask for another cause.
    const listed = floorAsk('python3', ['job.py'], ['python3 *'])
    expect(withJudged({ kind: 'ask', asks: [listed] }, new Set([passKey(interpreter)]))).toEqual({ kind: 'ask', asks: [listed] })
    // The quick stage may pass a destructive-list ask, under its own key.
    expect(withJudged({ kind: 'ask', asks: [listed] }, new Set([passKey(listed)]))).toEqual({ kind: 'allow', allowedBy: [`judge:destructive_command:${listed.subject}`] })
  })
})
