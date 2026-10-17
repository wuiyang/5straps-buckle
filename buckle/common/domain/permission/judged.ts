import type { JudgeResult } from '../../types/ports/judge.js'
import type { PermissionDecision } from './decision.js'
import type { PermissionOutcome } from './engine.js'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/** How an ask the decision AI passed reads in allowedBy and approvedBy: `judge:destructive_command:<subject>` (D91). */
export const JUDGE = 'judge'

/** The confidence a `safe` verdict needs before it passes a call (D91); any other verdict asks as before. */
export const JUDGE_PASS_CONFIDENCE = 0.8

/**
 * Whether the decision AI may answer an ask (D91): the destructive floor's ask about an interpreter the policy does not
 * allow, and nothing else. Never a deny, a built-in floor reason, another reading limit, or the workspace's destructive list.
 */
export function judgeable(ask: Ask): boolean {
  return ask.rule === 'destructive_command' && ask.cause === 'interpreter'
}

/** Whether a rating passes the call: `safe` at JUDGE_PASS_CONFIDENCE or above. A `warning` never runs without a person. */
export function judgePasses(result: JudgeResult): boolean {
  return result.kind === 'verdict' && result.level === 'safe' && result.confidence >= JUDGE_PASS_CONFIDENCE
}

/**
 * The outcome with every ask the decision AI passed (`passed`, by subject) taken out: an allow naming each as
 * `judge:<rule>:<subject>` beside the grants the rest of the call relied on, once no ask is left; the asks left otherwise.
 * Applied to each check the approval registry makes, so a call cleared after a person answered its other asks is not
 * asked about the passed one again.
 */
export function withJudged(outcome: PermissionOutcome, passed: ReadonlySet<string>): PermissionOutcome {
  if (outcome.kind !== 'ask' || passed.size === 0) return outcome
  const left = outcome.asks.filter(ask => !(judgeable(ask) && passed.has(ask.subject)))
  if (left.length === outcome.asks.length) return outcome
  if (left.length > 0) return { ...outcome, asks: left }
  return { kind: 'allow', allowedBy: [...outcome.allowedBy ?? [], ...outcome.asks.map(ask => `${JUDGE}:${ask.rule}:${ask.subject}`)] }
}
