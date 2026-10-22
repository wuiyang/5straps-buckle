import type { JudgeResult } from '../../types/ports/judge.js'
import type { QuickJudgeScope, QuickResult } from '../../types/ports/quick-judge.js'
import type { AskCause, GrantLookup, PermissionDecision } from './decision.js'
import type { PermissionOutcome } from './engine.js'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/** How an ask the decision AI passed reads in allowedBy and approvedBy: `judge:destructive_command:<subject>` (D91). */
export const JUDGE = 'judge'

/** The confidence a verdict needs before it acts (D91): a thorough `safe` one passes a call, and a quick `danger` one goes straight to a person. */
export const JUDGE_PASS_CONFIDENCE = 0.8

/**
 * Whether the thorough stage answers an ask on its own in automated mode (D91, addendum 3 R1): the destructive floor's
 * ask about an interpreter the policy does not allow, and nothing else, once the quick stage, where its scope covers the
 * ask, rated it anything but danger at 0.8 or above; a quick danger goes to a person with the thorough stage not asked. A
 * built-in floor reason, another reading limit, and the workspace's destructive list go to a person, the quick stage's
 * rating beside the action where its scope covers them; a deny is no ask, and is refused unrated. On request the
 * thorough stage also rates any ask that scope covers, and its safe approves an interpreter ask, or an allowed command
 * the quick stage flagged under `all`, never a floor ask (addendum 3 R2; fix brief 9, B37).
 */
export function judgeable(ask: Ask): boolean {
  return ask.rule === 'destructive_command' && ask.cause === 'interpreter'
}

/**
 * Whether the quick stage's scope (approval.quickJudge) covers an ask (D91, addendum 2 B): `interpreters`, the asks the
 * thorough stage answers; `asks` and `all`, every command ask a person would see, at the destructive floor for any reason.
 * Never a deny, which is no ask, and never an ask the gate itself made of a quick danger verdict.
 */
export function quickCovers(scope: QuickJudgeScope, ask: Ask): boolean {
  if (scope === 'off') return false
  if (scope === 'interpreters') return judgeable(ask)
  return ask.rule === 'destructive_command' && ask.cause !== undefined && ask.cause !== 'judge'
}

/**
 * Whether a thorough verdict passes the call: `safe` at JUDGE_PASS_CONFIDENCE or above. A `warning` never runs without a
 * person, and the quick stage's verdict is a rating alone, never a pass (addendum 3 R1).
 */
export function judgePasses(result: JudgeResult): boolean {
  return result.kind === 'verdict' && result.level === 'safe' && result.confidence >= JUDGE_PASS_CONFIDENCE
}

/** Whether a rating is `danger` at JUDGE_PASS_CONFIDENCE or above: from the quick stage, that goes to a person with no thorough call. */
export function ratedDanger(result: JudgeResult | QuickResult): boolean {
  return result.kind === 'verdict' && result.level === 'danger' && result.confidence >= JUDGE_PASS_CONFIDENCE
}

/**
 * Whether an ask's cause is the destructive floor's own (addendum 3 R2): the built-in floor (sudo and the destructive
 * commands) or the workspace's destructive list. No stage ever passes such an ask, whatever it rates it; the thorough
 * stage is not asked about one in automated mode, and on request its safe approves nothing.
 */
export function floorCause(cause: AskCause | undefined): boolean {
  return cause === 'floor' || cause === 'destructive-list'
}

/**
 * What a pass binds to (fix brief 9, B31): the cache key of what the stages were shown of the command, its files' sha256
 * among it, and whether they were shown it as an allowed command, so the same view can be read again before the run.
 */
export interface CodeBinding { key: string; allowed: boolean }

/** Why a pass did not run its call: the code it rated changed before the program started (fix brief 9, B31). */
export const CODE_CHANGED_REASON = 'the code changed after the decision AI rated it'

/** Thrown before a call's program starts where the code a pass rated changed (`subjects`): nothing ran, and a person decides. */
export class CodeChangedError extends Error {
  constructor(readonly subjects: readonly string[] = []) {
    super(CODE_CHANGED_REASON)
    this.name = 'CodeChangedError'
  }
}

/** What a stage's pass is kept under: the cause and the subject of the ask it rated, so it lifts that ask and no other. */
export function passKey(ask: { cause?: AskCause | undefined; subject: string }): string {
  return `${ask.cause ?? 'none'}:${ask.subject}`
}

/** What an allowed command the quick stage rated danger asks with (D91, addendum 2 B): the level alone, never a reasoning. */
export const QUICK_FLAG_REASON = 'The decision AI\'s quick stage rated this command danger, so a person decides; nothing it says refuses a command'

/**
 * The outcome with an ask for each allowed command the quick stage rated danger at 0.8 or above (`flagged`, scope all),
 * unless a grant already answers it, as the destructive floor's own grants do: a `once` or `session` for that subject. A
 * deny stays a deny; nothing the decision AI says refuses a call.
 */
export function withFlagged(outcome: PermissionOutcome, flagged: readonly Ask[], grants: GrantLookup): PermissionOutcome {
  if (outcome.kind === 'deny' || flagged.length === 0) return outcome
  const granted = new Set(grants.subjectsFor('destructive_command'))
  const relied = flagged.filter(item => granted.has(item.subject)).map(item => `destructive_command:${item.subject}`)
  const asked = new Set(outcome.kind === 'ask' ? outcome.asks.map(item => `${item.rule}:${item.subject}`) : [])
  const open = flagged.filter(item => !granted.has(item.subject) && !asked.has(`destructive_command:${item.subject}`))
  const allowedBy = [...(outcome.kind === 'allow' ? outcome.allowedBy : outcome.allowedBy ?? []), ...relied]
  if (outcome.kind === 'ask') return { ...outcome, asks: [...outcome.asks, ...open], allowedBy }
  return open.length === 0 ? { kind: 'allow', allowedBy } : { kind: 'ask', asks: open, allowedBy }
}

/**
 * The outcome with every ask the decision AI passed (`passed`, by passKey) taken out: an allow naming each as
 * `judge:<rule>:<subject>` beside the grants the rest of the call relied on, once no ask is left; the asks left otherwise.
 * Applied to each check the approval registry makes, so a call cleared after a person answered its other asks is not
 * asked about the passed one again.
 */
export function withJudged(outcome: PermissionOutcome, passed: ReadonlySet<string>): PermissionOutcome {
  if (outcome.kind !== 'ask' || passed.size === 0) return outcome
  const left = outcome.asks.filter(ask => !(ask.rule === 'destructive_command' && ask.cause !== 'judge' && passed.has(passKey(ask))))
  if (left.length === outcome.asks.length) return outcome
  if (left.length > 0) return { ...outcome, asks: left }
  return { kind: 'allow', allowedBy: [...outcome.allowedBy ?? [], ...outcome.asks.map(ask => `${JUDGE}:${ask.rule}:${ask.subject}`)] }
}
