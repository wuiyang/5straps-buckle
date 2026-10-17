import type { JudgeInput, JudgeLevel } from './judge.js'

/**
 * The decision AI's optional quick stage (D91, addendum 2 B): a decision model that answers a typed question with a
 * choice and a confidence in well under a second, with no written reasoning (TypeSafe AI's Jev, adapters/judge/typesafe.ts).
 * It reads the same input as the thorough stage and answers in the same three levels.
 */
export interface QuickJudge {
  quick(input: JudgeInput, options: { model: string; signal?: AbortSignal }): Promise<QuickResult>
}

export type QuickResult =
  | { kind: 'verdict'; level: JudgeLevel; confidence: number; probabilities: Record<JudgeLevel, number>; model: string; latencyMs: number }
  /** No verdict: a timeout, the network, an HTTP error, an answer that is no choice, or a call larger than it reads. Never names a host path or a key. */
  | { kind: 'unavailable'; reason: string }

export type QuickVerdict = Extract<QuickResult, { kind: 'verdict' }>

/** The providers approval.quickJudgeProvider may name, each an adapter of this port. */
export const QUICK_JUDGE_PROVIDERS = ['typesafe'] as const
export type QuickJudgeProvider = typeof QUICK_JUDGE_PROVIDERS[number]

/**
 * Which calls the quick stage rates (approval.quickJudge): none; the interpreter asks the thorough stage rates; every
 * command ask a person would see; or every command, allowed ones included, where only a danger verdict changes anything.
 */
export const QUICK_JUDGE_SCOPES = ['off', 'interpreters', 'asks', 'all'] as const
export type QuickJudgeScope = typeof QUICK_JUDGE_SCOPES[number]

/**
 * The most the quick stage is sent, as the input's JSON in bytes (D91, addendum 2 B): about 40k tokens at four bytes a
 * token, inside Jev's 64k context with room for the question. A larger call is not sent to it at all.
 */
export const QUICK_STATE_BUDGET_BYTES = 160 * 1_024
