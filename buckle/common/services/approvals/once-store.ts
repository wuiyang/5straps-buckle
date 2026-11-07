import { z } from 'zod'
import { GrantSubjectSchema, type GrantSubject } from '@5straps/protocol'
import type { PermissionOutcome } from '../../domain/permission/engine.js'
import type { CodeBinding } from '../../domain/permission/judged.js'

/**
 * A `once` approval, kept in approvals.json beside the asks under the same lock. `fingerprint` and `actor`: the call it
 * was asked for and the identity its transport authenticated, which alone spend it. `decidedBy`: key:<fingerprint> when a person's key signed it. `code`: the code a once the
 * decision AI's thorough stage gave on request binds to.
 */
export const onceSchema = z.object({
  workspace: z.string(), token: z.string(), subject: GrantSubjectSchema,
  sessionId: z.string(), actor: z.string().optional(), tool: z.string(), expiresAt: z.string(), requestId: z.string().optional(),
  fingerprint: z.string().optional(), decidedBy: z.string().optional(),
  code: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), allowed: z.boolean() }).optional(),
})
export type OnceEntry = z.infer<typeof onceSchema>

/** One call's last check, and what it may spend: the `once` approvals of its workspace, session, actor and tool. */
export interface OnceSpend {
  tokens: string[]
  sessionId: string
  /** The identity the call's transport authenticated; absent for the node's own process. */
  actor?: string
  tool: string
  /** The call's fingerprint: a `once` is spent only by the call it was asked for. */
  fingerprint?: string
  check: (subjects: GrantSubject[]) => PermissionOutcome
  /** Runs once the call clears: false (another run of the call holds it) leaves the onces unspent. */
  admit?: () => boolean
  /** Told, when the call clears, who decided each `once` it spent (key:<fingerprint>), for its audit entry. */
  spent?: (decidedBy: string[]) => void
  /** Whether the code a `once` binds to is still the code the call would run; a bound once is left unspent without it. */
  holds?: (subject: GrantSubject, code: CodeBinding) => boolean
}

/**
 * The call's last check with the onces it may spend, and the list with the ones it spent taken out. Only the onces it
 * needs are spent: those its tokens name and, where it would ask without them, the ones a rule relied on.
 */
export function spendOnces(onces: readonly OnceEntry[], input: { workspace: string; spend: OnceSpend }): { outcome: PermissionOutcome; kept: OnceEntry[] } {
  const { spend } = input
  // A once names the call it was asked for; any other call, token or not, cannot spend it.
  const bound = onces.filter(entry => entry.workspace === input.workspace && entry.sessionId === spend.sessionId && entry.actor === spend.actor && entry.tool === spend.tool && Date.parse(entry.expiresAt) > Date.now() && (entry.fingerprint === undefined || entry.fingerprint === spend.fingerprint) && (entry.code === undefined || (spend.holds?.(entry.subject, entry.code) ?? false)))
  const usable = bound.filter(entry => spend.tokens.includes(entry.token))
  let used = [...usable, ...unclaimedReliedOn({ usable, unclaimed: bound.filter(entry => !spend.tokens.includes(entry.token)), check: spend.check })]
  // The last check is the one the caller acts on, so it sees only the approvals this call uses.
  let outcome = spend.check(used.map(entry => entry.subject))
  while (outcome.kind === 'allow') {
    const live = used.filter(entry => Date.parse(entry.expiresAt) > Date.now())
    if (live.length === used.length) break
    used = live
    outcome = spend.check(used.map(entry => entry.subject))
  }
  // Keep partial approvals until every gate clears.
  if (outcome.kind !== 'allow' || !(spend.admit?.() ?? true)) return { outcome, kept: [...onces] }
  const consumed = new Set(used.map(entry => entry.token))
  spend.spent?.([...new Set(used.flatMap(entry => entry.decidedBy === undefined ? [] : [entry.decidedBy]))])
  return { outcome, kept: onces.filter(entry => !consumed.has(entry.token)) }
}

/** The list without a workspace's onces of these tokens, and the tokens it dropped. */
export function dropOnces(onces: readonly OnceEntry[], input: { workspace: string; tokens: ReadonlySet<string> }): { kept: OnceEntry[]; dropped: string[] } {
  const dropping = (entry: OnceEntry) => entry.workspace === input.workspace && input.tokens.has(entry.token)
  return { kept: onces.filter(entry => !dropping(entry)), dropped: onces.filter(dropping).map(entry => entry.token) }
}

/** One session's onces not yet spent nor expired, whichever actor asked, each with the tool it was asked for. */
export function unspentOnces(onces: readonly OnceEntry[], input: { workspace: string; sessionId: string }): Array<{ subject: GrantSubject; tool: string }> {
  return onces
    .filter(entry => entry.workspace === input.workspace && entry.sessionId === input.sessionId && Date.parse(entry.expiresAt) > Date.now())
    .map(entry => ({ subject: entry.subject, tool: entry.tool }))
}

export function liveOnces(onces: readonly OnceEntry[], now: number): OnceEntry[] {
  return onces.filter(entry => Date.parse(entry.expiresAt) > now)
}

/**
 * A `once` answered after the grace period has no call left to carry its token: over MCP the retry arrives without one.
 * When the call would otherwise ask, an unconsumed `once` for this session and tool counts, but only the ones a rule
 * actually relied on for this call's effects, so a `once` still covers one call with that subject and nothing wider.
 *
 * Only the smallest set the call needs is spent: one `once` per subject, the one expiring first, and none whose subject
 * is already covered without it, by a session grant for instance. The others stay for the next call rather than wasting
 * an owner's answer.
 */
function unclaimedReliedOn(input: { usable: OnceEntry[]; unclaimed: OnceEntry[]; check: (subjects: GrantSubject[]) => PermissionOutcome }): OnceEntry[] {
  if (input.unclaimed.length === 0) return []
  if (input.check(input.usable.map(entry => entry.subject)).kind !== 'ask') return []
  const wider = input.check([...input.usable, ...input.unclaimed].map(entry => entry.subject))
  if (wider.kind !== 'allow') return []
  const relied = new Set(wider.allowedBy)
  const firstPerSubject = new Map<string, OnceEntry>()
  for (const entry of [...input.unclaimed].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))) {
    const key = `${entry.subject.rule}:${entry.subject.subject}`
    if (relied.has(key) && !firstPerSubject.has(key)) firstPerSubject.set(key, entry)
  }
  let needed = [...firstPerSubject.values()]
  for (const entry of [...needed]) {
    const without = needed.filter(other => other !== entry)
    if (input.check([...input.usable, ...without].map(other => other.subject)).kind === 'allow') needed = without
  }
  return needed
}
