import type { GrantRecord, GrantSubject, PermissionRuleId } from '@5straps/protocol'
import type { GrantLookup } from '../../domain/permission/decision.js'
import type { PermissionOutcome } from '../../domain/permission/engine.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import { servesHolder, suspendedSessionApproval, type GrantHolder } from '../../domain/permission/grant-holder.js'
import type { LedgerGrants } from '../../types/ports/grant-store.js'
import type { ApprovalRegistry } from './approval-registry.js'
import type { UnspentOnce } from './once-store.js'
import type { ApprovalAskInput, ApprovalService, ApprovalWaitResult } from './approval-service.js'

/** One call's check through the gate: who calls, and its rules over the grants the gate hands them. */
export interface GateCheck extends GrantHolder {
  tokens: string[]
  tool: string
  /** The call's fingerprint: a `once` is spent only by the call it was asked for. */
  fingerprint?: string
  check: (grants: GrantLookup) => PermissionOutcome
  /** Claims the call's execution once it clears, under the ledger's lock; false leaves its onces unspent. */
  admit?: () => boolean
  /** Whether the code a `once` binds to is still the code the call would run. */
  holds?: (subject: GrantSubject, code: CodeBinding) => boolean
}

export interface GateClearance {
  outcome: PermissionOutcome
  /** The onces the last check counted, which the call's later checks count too. */
  relied: GrantSubject[]
  /** Who decided each once the call spent (key:<fingerprint>), present when it cleared and spent them. */
  decidedBy?: string[]
}

/**
 * The one way a call meets approvals: its last check spends its onces and claims its execution under the ledger's lock,
 * its grants serve the actor that asked, and its asks are recorded and waited on. A once and a session grant serve only
 * the actor whose call asked. While `sessionApprovalsSuspended` says so of the call's session, as while its activity cannot
 * be read, none of its session approvals clears a call; a denial binds whatever.
 */
export interface ApprovalGate {
  clear(input: GateCheck): Promise<GateClearance>
  grants(input: GrantHolder & { consumed: readonly GrantSubject[] }): GrantLookup
  /** The session and always grants a holder's calls may rely on, as they stand. */
  standing(holder: GrantHolder): GrantRecord[]
  /** Records the call's asks, or joins the ones it already made, and waits as its entry point holds it. */
  ask(input: ApprovalAskInput): Promise<ApprovalWaitResult>
  wasDenied(tokens: string[]): boolean
  withdraw(tokens: string[]): Promise<void>
  /** One session's onces not yet spent, whichever actor asked, each naming it: what `buckle check-url --session` shows the owner. */
  unspent(sessionId: string): UnspentOnce[]
}

export function createApprovalGate(input: { ledger: ApprovalRegistry; grants: LedgerGrants; service: ApprovalService; sessionApprovalsSuspended: (session: GrantHolder) => boolean }): ApprovalGate {
  const { ledger, grants, service, sessionApprovalsSuspended } = input
  return {
    async clear(call) {
      const holder = holderOf(call)
      let relied: GrantSubject[] = []
      let decidedBy: string[] | undefined
      const outcome = await ledger.evaluate({
        tokens: call.tokens, ...holder, tool: call.tool,
        ...(call.fingerprint === undefined ? {} : { fingerprint: call.fingerprint }),
        ...(call.admit === undefined ? {} : { admit: call.admit }),
        ...(call.holds === undefined ? {} : { holds: call.holds }),
        check: (subjects) => {
          relied = subjects
          return call.check(grantLookup({ store: grants, holder, consumed: subjects, sessionApprovalsSuspended: sessionApprovalsSuspended(holder) }))
        },
        spent: (deciders) => { decidedBy = deciders },
      })
      return { outcome, relied, ...(decidedBy === undefined ? {} : { decidedBy }) }
    },
    grants: ({ consumed, ...holder }) => {
      const session = holderOf(holder)
      return grantLookup({ store: grants, holder: session, consumed, sessionApprovalsSuspended: sessionApprovalsSuspended(session) })
    },
    standing: (holder) => {
      const session = holderOf(holder)
      return standingGrants(grants, session, sessionApprovalsSuspended(session))
    },
    ask: request => service.request(request),
    wasDenied: tokens => ledger.wasDenied(tokens),
    withdraw: tokens => service.withdraw(tokens),
    unspent: sessionId => ledger.unspent(sessionId),
  }
}

/** The grants a holder's checks read, with the onces its call counts beside them; see ApprovalGate for `sessionApprovalsSuspended`. */
export function grantLookup(input: { store: Pick<LedgerGrants, 'activeSubjects' | 'activePatterns' | 'list'>; holder: GrantHolder; consumed: readonly GrantSubject[]; sessionApprovalsSuspended?: boolean }): GrantLookup {
  const { store, holder } = input
  const filter = input.sessionApprovalsSuspended === true ? { sessionApprovalsSuspended: true } : {}
  return {
    // A lasting denial binds its whole session, whichever actor asked in it.
    deniedSubjectsFor: rule => deniedSubjects(store, holder.sessionId, rule),
    subjectsFor: (rule, scopes) => [...store.activeSubjects({ ...holder, ...filter, rule, ...(scopes === undefined ? {} : { scopes }) }), ...(scopes === undefined || scopes.includes('once') ? subjectsByRule(input.consumed, rule) : [])],
    // A `once` stays exact, so only standing grants can hold a pattern.
    patternsFor: rule => store.activePatterns({ ...holder, ...filter, rule }),
  }
}

function holderOf(input: GrantHolder): GrantHolder {
  return { sessionId: input.sessionId, ...(input.actor === undefined ? {} : { actor: input.actor }) }
}

function standingGrants(store: LedgerGrants, holder: GrantHolder, suspended: boolean): GrantRecord[] {
  const now = Date.now()
  return store.list().filter(grant => !grant.denied && grant.scope !== 'once' && servesHolder(grant, holder) && (!grant.expiresAt || Date.parse(grant.expiresAt) > now) && !suspendedSessionApproval(grant, suspended))
}

function deniedSubjects(store: Pick<LedgerGrants, 'list'>, sessionId: string, rule: PermissionRuleId): string[] {
  const now = Date.now()
  return store.list().filter(record => record.denied && record.rule === rule && (record.sessionId === null || record.sessionId === sessionId) && (!record.expiresAt || Date.parse(record.expiresAt) > now)).map(record => record.subject)
}

function subjectsByRule(subjects: readonly GrantSubject[], rule: PermissionRuleId): string[] {
  return subjects.filter(subject => subject.rule === rule).map(subject => subject.subject)
}
