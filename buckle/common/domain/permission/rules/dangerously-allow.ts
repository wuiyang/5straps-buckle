import type { PermissionRuleId } from '@5straps/protocol'
import { isDangerouslyAllowLevel, type DangerouslyAllowLevel } from '../../../types/ports/dangerously-allow-store.js'
import { isInside } from '../../paths.js'
import type { PermissionDecision } from '../decision.js'
import type { PermissionEngine } from '../engine.js'
import { isSecretFileSubject, SECRET_FILE_PREFIX } from './sensitive-path-rule.js'

/** How an ask the switch let through reads in allowedBy and approvedBy: `dangerously_allow:<level>:<rule>:<subject>`. */
export const DANGEROUSLY_ALLOW = 'dangerously_allow'

/** A command subject keeps its executable only: its arguments can carry a credential. */
const MAX_SUBJECT_LENGTH = 200

/** What the switch covers, as the owner said it (decision D7): bound to the workspace root, or its mount when one is set. */
export const DANGEROUSLY_ALLOW_SCOPE = 'bound to the workspace root, or its mount when one is set'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/**
 * The workspace's dangerously-allow switch (rulings 11 and H1 of 2026-09-28, owner decision D7 of
 * 2026-09-29): every ask becomes an allow, sensitive files and file writes included, reported as
 * `dangerously_allow:<level>:<rule>:<subject>` so the invoker audits each use at the level it ran at. At level
 * `command` a secret reference's file is the one ask it leaves to a person (docs/secrets.md); at level `all` it
 * answers that one too (owner ruling of 2026-10-25). It is bound to the workspace at either level:
 * an ask about a path outside the workspace root (which a mount presents) keeps its question, so the
 * switch never opens the rest of the host. Asks that name no path (commands, hosts, process probes)
 * are covered wherever they point. A deny is never turned: the engine returns the first deny before
 * any ask, so an owner's deny rule, the node's policy over the workspace, the mount boundary and the
 * state directory still refuse. `level` and `root` are read at every evaluation, so the local
 * switch takes effect in a running node at once, off (null) as well as on.
 */
export function withDangerouslyAllow(engine: PermissionEngine, input: { level: () => DangerouslyAllowLevel | null; root: () => string }): PermissionEngine {
  return {
    evaluate(call) {
      const outcome = engine.evaluate(call)
      if (outcome.kind !== 'ask') return outcome
      const level = input.level()
      if (level === null) return outcome
      const root = input.root()
      const outside = outcome.asks.filter(ask => !covers({ ask, root, level }))
      if (outside.length > 0) return { ...outcome, asks: outside }
      return { kind: 'allow', allowedBy: outcome.asks.map(ask => `${DANGEROUSLY_ALLOW}:${level}:${ask.rule}:${ask.subject}`) }
    },
  }
}

/**
 * Whether the switch answers this ask: one about a path only inside the workspace root. A secret file's use is one only
 * at level `all`; at `command` a person allows it (docs/secrets.md).
 */
function covers(input: { ask: Ask; root: string; level: DangerouslyAllowLevel }): boolean {
  const { ask, root, level } = input
  if (ask.rule === 'sensitive_path' && isSecretFileSubject(ask.subject) && level !== 'all') return false
  const path = askedPath(ask)
  return path === null || isInside(root, path)
}

/** The real path a path rule asks about; null for a rule whose subject is not a path. */
function askedPath(ask: Ask): string | null {
  switch (ask.rule) {
    // A secret reference's file is asked about as `secret-file:<path>` (sensitive-path-rule.ts).
    case 'sensitive_path':
      return isSecretFileSubject(ask.subject) ? ask.subject.slice(SECRET_FILE_PREFIX.length) : ask.subject
    case 'read_scope':
    case 'write_scope':
      return ask.subject
    // `read:<path>` or `write:<path>` (filesystem-policy.ts).
    case 'filesystem_policy':
      return ask.subject.slice(ask.subject.indexOf(':') + 1)
    default:
      return null
  }
}

/** The uses an allowedBy list holds, each with the level the switch was on at, the rule it overrode, and the subject it asked about. */
export function dangerousUses(allowedBy: readonly string[]): Array<{ level: DangerouslyAllowLevel; rule: PermissionRuleId; subject: string }> {
  return allowedBy.flatMap((key) => {
    const [prefix, level, rule, ...subject] = key.split(':')
    return prefix === DANGEROUSLY_ALLOW && isDangerouslyAllowLevel(level) && rule ? [{ level, rule: rule as PermissionRuleId, subject: subject.join(':') }] : []
  })
}

/** What the audit keeps of a subject: a path or host as written (capped), a command line as its executable and its length. */
export function redactedSubject(rule: PermissionRuleId, subject: string): string {
  if (rule === 'destructive_command') return `${subject.split(' ', 1)[0]!.slice(0, MAX_SUBJECT_LENGTH)} [${subject.length} characters]`
  return subject.length > MAX_SUBJECT_LENGTH ? `[${subject.length} characters]` : subject
}
