import type { PermissionRuleId } from '@5straps/protocol'
import { isDangerouslyAllowOnMode, type DangerouslyAllowMode, type DangerouslyAllowOnMode } from '../../../types/ports/dangerously-allow-store.js'
import { isInside } from '../../paths.js'
import { type PermissionDecision, unreadCodeCause } from '../decision.js'
import type { PermissionEngine } from '../engine.js'
import { floorSubjectPath, isFloorSubject, isRestoreSubject, isSecretFileSubject, SECRET_FILE_PREFIX } from '../subjects.js'

/** How an ask the switch let through reads in allowedBy and approvedBy: `dangerously_allow:<mode>:<rule>:<subject>`. */
export const DANGEROUSLY_ALLOW = 'dangerously_allow'

/** What the switch covers, as the owner said it (decision D7): bound to the workspace root, or its mount when one is set. */
export const DANGEROUSLY_ALLOW_SCOPE = 'bound to the workspace root, or its mount when one is set'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/** What a mode answers beyond the asks every mode covers. */
export interface ModeReach {
  /** Floor asks: the built-in command floor, the destructive list, and the file floor. */
  floor: boolean
  /** A secret reference's file. */
  secretFile: boolean
  /** A call running code Buckle does not read: through an interpreter the workspace's policy does not allow, or a script file run directly. */
  unreadCode: boolean
}

/**
 * Each mode's reach. `safe` leaves floor asks, unread code, and a secret reference's file to a person (or, for unread
 * code, to the decision AI where it is set to answer); each is one field of its row to change.
 */
export const DANGEROUSLY_ALLOW_REACH: Readonly<Record<DangerouslyAllowOnMode, Readonly<ModeReach>>> = {
  on: { floor: true, secretFile: true, unreadCode: true },
  safe: { floor: false, secretFile: false, unreadCode: false },
}

/**
 * The workspace's dangerously-allow switch (rulings 11 and H1 of 2026-09-28, owner decision D7 of
 * 2026-09-29): every ask it covers becomes an allow, sensitive files and file writes included, reported as
 * `dangerously_allow:<mode>:<rule>:<subject>` so the invoker audits each use at the mode it ran at. What each mode
 * answers beyond that is its reach (DANGEROUSLY_ALLOW_REACH); a call with asks both inside and outside a mode's reach
 * asks those outside it alone. A restore of the change history it leaves to a person in every mode, as every restore
 * asks one. It is bound to the workspace in every mode:
 * an ask about a path outside the workspace root (which a mount presents) keeps its question, so the
 * switch never opens the rest of the host. Asks that name no path (commands, hosts, process probes)
 * are covered wherever they point. A deny is never turned: the engine returns the first deny before
 * any ask, so an owner's deny rule, the node's policy over the workspace, the mount boundary and the
 * state directory still refuse. `mode` and `root` are read at every evaluation, so the local
 * switch takes effect in a running node at once, off as well as on.
 */
export function withDangerouslyAllow(engine: PermissionEngine, input: { mode: () => DangerouslyAllowMode; root: () => string }): PermissionEngine {
  return {
    evaluate(call) {
      const outcome = engine.evaluate(call)
      if (outcome.kind !== 'ask') return outcome
      const mode = input.mode()
      if (mode === 'off') return outcome
      const root = input.root()
      const reach = DANGEROUSLY_ALLOW_REACH[mode]
      const kept = outcome.asks.filter(ask => !coversAsk({ ask, root, reach }))
      if (kept.length > 0) return { ...outcome, asks: kept }
      return { kind: 'allow', allowedBy: outcome.asks.map(ask => `${DANGEROUSLY_ALLOW}:${mode}:${ask.rule}:${ask.subject}`) }
    },
  }
}

/** Whether the switch answers this ask: one inside its reach, and about a path only inside the workspace root. */
export function coversAsk(input: { ask: Ask; root: string; reach: Readonly<ModeReach> }): boolean {
  const { ask, root, reach } = input
  if (ask.floor && !reach.floor) return false
  if (unreadCodeCause(ask.cause) && !reach.unreadCode) return false
  if (ask.rule === 'sensitive_path' && isSecretFileSubject(ask.subject) && !reach.secretFile) return false
  if (ask.rule === 'write_scope' && isRestoreSubject(ask.subject)) return false
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
      return ask.subject
    // A delete at the floor is asked about as `delete:<folder>` or `delete-tree:<folder>` (destructive-path-rule.ts). A floor
    // subject that names no path (a restore's) is never read as one: its text would resolve against the working folder.
    case 'write_scope':
      return isFloorSubject(ask.subject) ? floorSubjectPath(ask.subject) : ask.subject
    // `read:<path>` or `write:<path>` (filesystem-policy.ts).
    case 'filesystem_policy':
      return ask.subject.slice(ask.subject.indexOf(':') + 1)
    default:
      return null
  }
}

/** The uses an allowedBy list holds, each with the mode the switch was on at, the rule it overrode, and the subject it asked about. */
export function dangerousUses(allowedBy: readonly string[]): Array<{ mode: DangerouslyAllowOnMode; rule: PermissionRuleId; subject: string }> {
  return allowedBy.flatMap((key) => {
    const [prefix, mode, rule, ...subject] = key.split(':')
    return prefix === DANGEROUSLY_ALLOW && isDangerouslyAllowOnMode(mode) && rule ? [{ mode, rule: rule as PermissionRuleId, subject: subject.join(':') }] : []
  })
}
