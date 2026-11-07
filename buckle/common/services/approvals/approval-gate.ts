import type { GrantRecord, GrantSubject, PermissionRuleId } from '@5straps/protocol'
import type { GrantLookup } from '../../domain/permission/decision.js'
import type { PermissionOutcome } from '../../domain/permission/engine.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import { servesHolder, type GrantHolder } from '../../domain/permission/grant-holder.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import type { ApprovalRegistry } from './approval-registry.js'
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
 * the actor whose call asked.
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
  /** One session's onces not yet spent, whichever actor asked: what `buckle check-url --session` shows the owner. */
  unspent(sessionId: string): Array<{ subject: GrantSubject; tool: string }>
}

export function createApprovalGate(input: { ledger: ApprovalRegistry; grants: GrantStore; service: ApprovalService }): ApprovalGate {
  const { ledger, grants, service } = input
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
          return call.check(grantLookup({ store: grants, holder, consumed: subjects }))
        },
        spent: (deciders) => { decidedBy = deciders },
      })
      return { outcome, relied, ...(decidedBy === undefined ? {} : { decidedBy }) }
    },
    grants: ({ consumed, ...holder }) => grantLookup({ store: grants, holder: holderOf(holder), consumed }),
    standing: holder => standingGrants(grants, holderOf(holder)),
    ask: request => service.request(request),
    wasDenied: tokens => ledger.wasDenied(tokens),
    withdraw: tokens => service.withdraw(tokens),
    unspent: sessionId => ledger.unspent(sessionId),
  }
}

/** The grants a holder's checks read, with the onces its call counts beside them. */
export function grantLookup(input: { store: GrantStore; holder: GrantHolder; consumed: readonly GrantSubject[] }): GrantLookup {
  const { store, holder } = input
  return {
    // A lasting denial binds its whole session, whichever actor asked in it.
    deniedSubjectsFor: rule => deniedSubjects(store, holder.sessionId, rule),
    subjectsFor: rule => [...store.activeSubjects({ ...holder, rule }), ...subjectsByRule(input.consumed, rule)],
    // A `once` stays exact, so only standing grants can hold a pattern.
    patternsFor: rule => store.activePatterns({ ...holder, rule }),
  }
}

function holderOf(input: GrantHolder): GrantHolder {
  return { sessionId: input.sessionId, ...(input.actor === undefined ? {} : { actor: input.actor }) }
}

function standingGrants(store: GrantStore, holder: GrantHolder): GrantRecord[] {
  const now = Date.now()
  return store.list().filter(grant => !grant.denied && grant.scope !== 'once' && servesHolder(grant, holder) && (!grant.expiresAt || Date.parse(grant.expiresAt) > now))
}

function deniedSubjects(store: GrantStore, sessionId: string, rule: PermissionRuleId): string[] {
  const now = Date.now()
  return store.list().filter(record => record.denied && record.rule === rule && (record.sessionId === null || record.sessionId === sessionId) && (!record.expiresAt || Date.parse(record.expiresAt) > now)).map(record => record.subject)
}

function subjectsByRule(subjects: readonly GrantSubject[], rule: PermissionRuleId): string[] {
  return subjects.filter(subject => subject.rule === rule).map(subject => subject.subject)
}
