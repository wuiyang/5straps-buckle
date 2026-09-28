import type { DangerouslyAllow, PermissionRuleId } from '@5straps/protocol'
import type { PermissionEngine } from '../engine.js'

/** How an ask the switch let through reads in allowedBy and approvedBy: `dangerously_allow:<rule>:<subject>`. */
export const DANGEROUSLY_ALLOW = 'dangerously_allow'

/** A command subject keeps its executable only: its arguments can carry a credential. */
const MAX_SUBJECT_LENGTH = 200

/** On only when both flags are: the one switch sets them together, so a half-set policy does not widen anything. */
export function isDangerouslyAllowed(flags: DangerouslyAllow | undefined): boolean {
  return flags?.commands === true && flags.fileReads === true
}

/**
 * The workspace's dangerously-allow switch (rulings 11 and H1 of 2026-09-28): every ask becomes an
 * allow, sensitive files and file writes included, reported as `dangerously_allow:<rule>:<subject>`
 * so the invoker audits each use. A deny is never turned: the engine returns the first deny before
 * any ask, so an owner's deny rule, the node's policy over the workspace, the mount boundary and the
 * state directory still refuse. `enabled` is read at every evaluation, so the local switch takes
 * effect in a running node at once, off as well as on.
 */
export function withDangerouslyAllow(engine: PermissionEngine, enabled: () => boolean): PermissionEngine {
  return {
    evaluate(input) {
      const outcome = engine.evaluate(input)
      if (outcome.kind !== 'ask' || !enabled()) return outcome
      return { kind: 'allow', allowedBy: outcome.asks.map(ask => `${DANGEROUSLY_ALLOW}:${ask.rule}:${ask.subject}`) }
    },
  }
}

/** The uses an allowedBy list holds, each with the rule it overrode and the subject it asked about. */
export function dangerousUses(allowedBy: readonly string[]): Array<{ rule: PermissionRuleId; subject: string }> {
  return allowedBy.flatMap((key) => {
    const [prefix, rule, ...subject] = key.split(':')
    return prefix === DANGEROUSLY_ALLOW && rule ? [{ rule: rule as PermissionRuleId, subject: subject.join(':') }] : []
  })
}

/** What the audit keeps of a subject: a path or host as written (capped), a command line as its executable and its length. */
export function redactedSubject(rule: PermissionRuleId, subject: string): string {
  if (rule === 'destructive_command') return `${subject.split(' ', 1)[0]!.slice(0, MAX_SUBJECT_LENGTH)} [${subject.length} characters]`
  return subject.length > MAX_SUBJECT_LENGTH ? `[${subject.length} characters]` : subject
}
