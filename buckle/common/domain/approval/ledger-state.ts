import { z } from 'zod'
import { ApprovalNoticeSchema, ApprovalDecisionSchema, ApprovalRequestSchema, GrantRecordSchema, GrantSubjectSchema, PermissionRuleIdSchema } from '@5straps/protocol'
import { askedCallSchema } from './asked-call.js'
import { GRANT_SAVES } from '../../types/ports/approval-backend.js'
import { BUILT_IN_SOURCES } from '../../types/ports/approval-source.js'

/**
 * A `once` approval, kept in approvals.json beside the asks under the same lock. `fingerprint` and `actor`: the call it
 * was asked for and the identity its transport authenticated, which alone spend it. `decidedBy`: key:<fingerprint> when
 * a person's key signed it. `code`: the code a once the decision AI's thorough stage gave on request binds to.
 */
const onceSchema = z.object({
  workspace: z.string(), token: z.string(), subject: GrantSubjectSchema,
  sessionId: z.string(), actor: z.string().optional(), tool: z.string(), expiresAt: z.string(), requestId: z.string().optional(),
  fingerprint: z.string().optional(), decidedBy: z.string().optional(),
  code: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), allowed: z.boolean() }).optional(),
})
export type OnceEntry = z.infer<typeof onceSchema>

// requestId and actor let a re-sent call join the ask it already made (ruling 5 of 2026-09-28); an
// answered entry keeps them, so a call re-sent after part of its asks were answered still joins.
const joinKey = { requestId: z.string().optional(), actor: z.string().optional() }
// fingerprint: the tool and its whole arguments that asked, hashed (requestFingerprint); a re-send joins
// only with the same one, and a once decided on its ask is spent only by it, whichever route decided it
// (review H3 of B23-B25; review item 1 of the proof-of-possession fixes).
const fingerprint = { fingerprint: z.string().optional() }
// decidedBy: key:<fingerprint> when a person's enrolled key signed the decision (review H4 of B23-B25).
const decidedBy = { decidedBy: z.string().optional() }
// lapsesAt: when an ask nobody holds lapses before its stated expiry, ten minutes after the last hold on it ended, and
// again from a re-send that joins it, never nearer (the MCP asks brief, item 5). An ask at wait 0 states no deadline,
// which its signed challenge carries, so the lapse is kept beside the request rather than in it; none while a caller
// holds it until answered. abandonedAt: when the caller that held it left before its hold ended; the oldest abandoned asks make room
// under the caps, so a session's or the workspace's cap is never reached through them alone.
const lapse = { lapsesAt: z.iso.datetime().optional(), abandonedAt: z.iso.datetime().optional() }
// callFile: the file beside approvals.json that holds the whole call of the ask's request group, once for every
// ask the call made, so the file every update rewrites holds requests alone (review M5). `bytes` counts against
// the budgets once per group; `complete` repeats the call's own mark. An ask recorded before this build keeps its
// call inline, in `call`.
const callFileSchema = z.object({ id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), bytes: z.number().int().nonnegative(), complete: z.literal(true).optional() })
// attempt: the attempt entry of the call that raised the ask, which each decision's record names; a re-send that joins
// shares its requestId.
const attempt = { attempt: z.object({ auditId: z.string(), requestId: z.string() }).optional() }
// floor and destructive: the marks the rule that asked set (AskMarks); an ask recorded before they were kept reads as both.
const marks = { floor: z.boolean().default(true), destructive: z.boolean().default(true) }
const pendingSchema = z.object({ request: ApprovalRequestSchema, sessionId: z.string(), workspace: z.string(), ...marks, ...joinKey, ...fingerprint, ...attempt, notify: z.literal(true).optional(), call: askedCallSchema.optional(), callFile: callFileSchema.optional(), ...lapse })
// grant: the session or always grant an approval makes, kept with its resolved entry under the id it is written with.
// `save` is `owed` until the grant store holds it, then `saved`; a skip turns it `skipping` until a grant that may have
// saved is confirmed gone, then `skipped`, which nothing writes again. The entry commits first, so a grant never stands
// without its decision; one left owed is written, and one left skipping removed, when the workspace opens again
// (recover) or by the next decision recorded or sent again. A revoke, a session end, or a lasting denial in its place
// turns an owed or saved one `dropped`. `source`: the route that recorded the decision, which alone may skip it. A lasting denial is never owed: it is
// written before its decision commits.
const sourceSchema = z.object({ id: z.string(), kind: z.enum([...BUILT_IN_SOURCES, 'backend']) })
const lastingGrantSchema = z.object({
  id: z.string().uuid(), sessionId: z.string(), actor: z.string().optional(), rule: PermissionRuleIdSchema, subject: z.string(), scope: z.enum(['session', 'always']),
  pattern: z.literal(true).optional(), ...decidedBy, source: sourceSchema, save: z.enum(GRANT_SAVES),
})
export type LastingGrant = z.infer<typeof lastingGrantSchema>
const resolvedSchema = z.object({
  workspace: z.string(), decision: ApprovalDecisionSchema, widenedTo: z.string().optional(), expiresAt: z.string(),
  request: ApprovalRequestSchema.optional(), sessionId: z.string().optional(), ...joinKey, ...fingerprint, ...decidedBy, ...attempt,
  grant: lastingGrantSchema.optional(),
})
const deliverySchema = z.object({ id: z.string().uuid(), workspace: z.string(), notice: ApprovalNoticeSchema, expiresAt: z.iso.datetime() })
// An ask a session end withdrew, or one nobody answered before it ran out (APPROVAL-36), kept as long as an answer is, so a
// process that did not end the session or drop the ask reads why it left.
const endedAskSchema = z.object({ workspace: z.string(), token: z.string(), expiresAt: z.iso.datetime() })
export type ApprovalDelivery = Omit<z.infer<typeof deliverySchema>, 'workspace'>

export const approvalLedgerSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  once: z.array(onceSchema),
  resolved: z.array(resolvedSchema),
  outbox: z.array(deliverySchema).default([]),
  ended: z.array(endedAskSchema).default([]),
  noResponse: z.array(endedAskSchema).default([]),
})
export type ApprovalLedgerState = z.infer<typeof approvalLedgerSchema>
export type ResolvedEntry = ApprovalLedgerState['resolved'][number]

const endingSchema = z.union([z.object({ sessionId: z.string() }), z.object({ sessions: z.array(z.object({ sessionId: z.string(), actor: z.string().optional() })).readonly() }), z.object({ allSessions: z.literal(true) })])
// A revoke, by the record it removed, or a session end, by when it ended, so one done late never reaches a grant made after
// it. Each drops the owed grants that would write again what it removed, applied before the next decision, so it reaches
// only grants decided before it.
const revocationSchema = z.union([z.object({ grant: GrantRecordSchema }), z.object({ ending: endingSchema, endedAt: z.iso.datetime() })])
export type Revocation = z.infer<typeof revocationSchema>
// `revoked`: made while approvals.json could not be read, so the ledger has yet to drop what each removed. `owed`: the
// ledger dropped it, and the grants file may still hold it. Both are recorded before the grant store is written, and an
// approval either names clears no call until the grant store confirms it gone.
export const revocationsSchema = z.object({ version: z.literal(1), revoked: z.array(revocationSchema), owed: z.array(revocationSchema) })
export type RevocationsFile = z.infer<typeof revocationsSchema>
export type PendingEntry = ApprovalLedgerState['pending'][number]

/**
 * An ask waiting in the queue, with the whole call it came from, read from its file. `callRef` names the file,
 * which every ask of one request group shares, so a listing carries the group's call once and each ask names it
 * (review M1 of the slice 5 re-review); an ask recorded before this build keeps its call inline and has none.
 */
export type PendingAsk = Omit<PendingEntry, 'workspace' | 'callFile'> & { callRef?: string }
