import { deniedSubjects } from '../../adapters/grant-store/file-grant-store.js'
import { randomUUID } from 'node:crypto'
import { useScopeSafe } from '@5straps/runtime'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { ChangeHistory } from '../history/journal.js'
import type { ApprovalWait, DeniedRunReport, InvokeRequest, InvokeResponse, JsonValue, PermissionRuleId, GrantSubject } from '@5straps/protocol'
import { summarizeEffect, type ResolvedEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import type { PermissionEngine, PermissionOutcome } from '../../domain/permission/engine.js'
import type { GrantLookup } from '../../domain/permission/decision.js'
import { redactAuditArguments, reviewableArguments } from '../../domain/redact.js'
import { describeCall } from '../../domain/describe-call.js'
import { DANGEROUSLY_ALLOW, dangerousUses, redactedSubject } from '../../domain/permission/rules/dangerously-allow.js'
import { AUDIT_UNAVAILABLE, AuditUnavailableError } from '../../adapters/action-log/file-action-log.js'
import type { ToolRegistry } from '../../domain/tool-registry.js'
import { ToolExecutionError, ToolInputError, type NetworkVerdict, type ToolContext } from '../../domain/tool.js'
import type { ActionLog, ActionLogEntry, GrantUse } from '../../types/ports/action-log.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import type { Reporter } from '../../types/ports/reporter.js'
import { logger } from '../../runtime/log.js'
import { resolveEffects, resolveHostRead } from './resolve-effects.js'
import { isStateBusy, STATE_BUSY_MESSAGE } from '../state-busy.js'
import { ActionTooLargeError, ApprovalConflictError, ApprovalLimitError, RequestIdReusedError, subjectsByRule, type ApprovalRegistry } from '../approvals/approval-registry.js'
import { shorterWait, type ApprovalService } from '../approvals/approval-service.js'
import { requestFingerprint, requestIdKey, REQUEST_ID_REUSED, type Earlier, type ExecutionClaim, type ExecutionKey, type Executions } from './executions.js'

/** Why a call's signal fired when its runtime shut down (B19): not the caller leaving. */
export class InvocationsClosedError extends Error {
  constructor() { super('Buckle is shutting down') }
}

/** The audit log's bound on caller-chosen ids. The join and dedupe keys hash the whole requestId instead (review L2 of B18-B19). */
const MAX_LOGGED_ID = 200
/**
 * The longest session id a caller may choose. It is stored with every ask and grant it makes, so an
 * unbounded one would let a caller grow approvals.json by its request size per ask (review L2 of B13-B14).
 */
export const MAX_SESSION_ID = 200

export interface InvokerOptions {
  registry: ToolRegistry
  permissions: PermissionEngine
  approvals: ApprovalRegistry
  /** Issues asks and waits for their answers; the one place a verdict is recorded. */
  approvalService: ApprovalService
  /** The workspace's calls that run now or ran lately, so a re-send never runs one twice. */
  executions: Executions
  grants: GrantStore
  history?: ChangeHistory
  historyRoots?: string[]
  actions: ActionLog
  reporter: Reporter
  paths: PathView
  serverId: string
  workspaceId?: string
  defaultTimeoutMs: number
  maxTimeoutMs: number
  toolDenial?(tool: string): string | null
  /**
   * The runtime's shutdown (B19): cancels a running tool and refuses calls that arrive later, but is
   * never the caller leaving, so an approval wait it ends leaves the asks pending (review L6 of B18-B19).
   */
  shutdown?: AbortSignal
}

export interface InvokeInput {
  request: InvokeRequest
  sessionId: string
  /** The caller's own signal: it ends the call's wait, and cancels a running tool. */
  signal?: AbortSignal
  /** Whether an abort of `signal` is an explicit cancel, which withdraws the call's asks (approval-service.ts). */
  isCancel?: (reason: unknown) => boolean
  /** The entry point's wait for an approval; with the caller's own hint, the shorter one holds. */
  approvalWait?: ApprovalWait
}

export interface Invoker {
  invoke(input: InvokeInput): Promise<InvokeResponse>
}

/** What the permission step decided, carried through so the action log can report the reason. */
interface GateOutcome {
  response: InvokeResponse | null
  asked: string[]
  approvedBy: string[]
  /** Set when the call was refused rather than run, whoever refused it. */
  denial?: { rule: PermissionRuleId; subject: string; reason: string }
  /** The once approvals this call was cleared with, which also cover what it reaches mid-call. */
  consumed?: GrantSubject[]
  /** The enrolled keys that decided the once approvals it spent (review item 6). */
  decidedBy?: string[]
  /** A call of the same key ran or runs: its outcome answers this one, which does not run. */
  earlier?: Earlier
}

export function createInvoker(options: InvokerOptions): Invoker {
  return {
    async invoke({ request, sessionId, signal, isCancel, approvalWait }) {
      const startedAt = performance.now()
      const auditId = randomUUID()
      // A required audit write that fails stops the call here, before anything runs (data.md).
      await options.actions.record({
        auditId, event: 'attempt', workspaceId: options.workspaceId ?? 'default',
        at: new Date().toISOString(), requestId: request.requestId.slice(0, MAX_LOGGED_ID), sessionId: sessionId.slice(0, MAX_LOGGED_ID),
        tool: request.tool.slice(0, MAX_LOGGED_ID), outcome: 'started', durationMs: 0, effects: [], args: redactAuditArguments(request.args),
        ...auditContext(request),

      })
      let effects: ResolvedEffect[] = []
      let gate: GateOutcome = { response: null, asked: [], approvedBy: [] }
      // A re-send is the same call when it comes from the same session and actor (review M2 of B13-B14).
      const key = executionKey({ request, sessionId })
      // The key's one execution, once the gate claims it; settled below whatever happens after.
      const held: { claim?: ExecutionClaim } = {}
      let replayed = false
      let ran = false
      // The caller leaving or the runtime shutting down: either stops a running tool.
      const stop = anySignal(signal, options.shutdown)
      // One entry per rule and subject a call's dangerously-allowed uses name, however often it meets them (review L12 of B20-B22).
      const grantUses = grantUseRecorder({ grants: options.grants, sessionId })
      const auditUses = useAuditor({ options, request, sessionId, grantUses })
      const answerEarlier = async (earlier: Earlier): Promise<InvokeResponse> => {
        if (earlier.kind === 'reused') return failed(request, REUSED)
        replayed = true
        // The key hashes the whole requestId, so the earlier call's is the same; the caller's own is echoed all the same.
        return { ...await untilAborted(earlier.response, stop), requestId: request.requestId }
      }

      let answered: InvokeResponse | undefined
      try { answered = await (async (): Promise<InvokeResponse> => {
        try {
          stop?.throwIfAborted()
          if (sessionId.length > MAX_SESSION_ID) return sessionIdTooLong(request)
          const earlier = options.executions.earlier(key)
          if (earlier) return await answerEarlier(earlier)
          const reason = options.toolDenial?.(request.tool)
          if (reason) {
            const response = denied(request, reason)
            gate = { response, asked: [], approvedBy: [], denial: { rule: 'tool_policy', subject: request.tool, reason } }
            return response
          }
          const prepared = options.registry.get(request.tool).prepare(request.args)
          effects = await resolveEffects({ effects: prepared.effects, paths: options.paths })

          gate = await clearPermissions({ options, request, sessionId, effects, signal, isCancel, approvalWait, key, held })
          stop?.throwIfAborted()
          if (gate.earlier) return await answerEarlier(gate.earlier)
          if (gate.response) return gate.response
          // Cleared: the gate claimed this key's one execution as it spent the call's approvals.
          if (held.claim?.kind !== 'owner') throw new Error('A cleared call holds no execution claim')
          const owned = held.claim.execution
          await auditUses(gate.approvedBy)
          const execute = () => {
            owned.started()
            ran = true
            return executeWithTimeout({ options, request, sessionId, signal: stop, consumed: gate.consumed ?? [], effects, auditUses, execute: prepared.execute })
          }
          const writes = effects.filter(effect => effect.kind === 'write_path')
          const roots = [...options.historyRoots ?? [], ...writes.map(effect => { let path = effect.path; while (!existsSync(path)) path = dirname(path); return realpathSync(path) })]
          const tracksChanges = writes.length > 0 || effects.some(effect => effect.kind === 'exec') && request.tool !== 'browser_command'
          const output = options.history && tracksChanges && !prepared.managesHistory
            ? await options.history.run({ sessionId, stageId: request.context?.stageId ?? request.context?.runId ?? request.requestId, tool: request.tool, roots: [...new Set(roots)] }, execute, stop)
            : await execute()
          // A tool that returns what its killed process left (a shell) ran into the shutdown all the same:
          // it answers as a tool that throws does, effects unknown (review L12 of B18-B19).
          if (options.shutdown?.aborted) throw options.shutdown.reason
          return {
            requestId: request.requestId,
            outcome: 'ok',
            output,
            meta: { durationMs: Math.round(performance.now() - startedAt), truncated: inferTruncated(output) },
          }
        } catch (error) {
          // A required audit entry that cannot be written stops the call, as the attempt's does. Once its
          // tool ran, the caller is told it ran with effects unknown and not to retry, as a re-send is: a
          // plain refusal would read as "nothing ran", and a retry under a new requestId would run it
          // again (review item 15 of the proof-of-possession fixes).
          if (error instanceof AuditUnavailableError) {
            if (ran) return failed(request, ranUnrecorded(AUDIT_UNAVAILABLE))
            throw error
          }
          // A tool killed by the shutdown answers as the shutdown, not with what its process left (review L8 of B20-B22).
          const cause = options.shutdown?.aborted ? options.shutdown.reason : error
          const shaped = shapeError(cause, request.tool)
          // Busy state after the tool ran is not a retry: the call happened (review L4 of B23-B25).
          return { requestId: request.requestId, outcome: 'error', error: ran && shaped.code === 'STATE_BUSY' ? ranUnrecorded('STATE_BUSY') : shaped }
        }
      })() } finally {
        // Settled whatever happened, before the result is recorded, so a re-send never waits on a call
        // that stopped (review L1 of B20-B22). An audit failure before the tool ran answers as a
        // retryable 503 would; once it ran, never retryable, so the same requestId never runs it again
        // (review L4 of B23-B25; nitro/coordination.md: reconnection must not execute a request twice).
        if (held.claim?.kind === 'owner') held.claim.execution.settle({ response: answered ?? (ran ? failed(request, ranUnrecorded(AUDIT_UNAVAILABLE)) : auditFailed(request)), auditId, callerLeft: signal?.aborted === true })
      }
      const response = answered

      const entry = buildEntry({
        request,
        sessionId,
        effects,
        gate,
        grantUses: grantUses.uses(),
        response,
        durationMs: Math.round(performance.now() - startedAt),
        replayed,
      })
      const result = { ...entry, auditId, event: 'result' as const, workspaceId: options.workspaceId ?? 'default', ...auditContext(request) }
      // A call that ran answers with what it did even when its result cannot be written: refusing it
      // would tell the caller it did not run, and a retry would run it twice (review L5 of B18-B19). The
      // attempt is already in the log, and recovery marks it interrupted.
      if (ran) await options.actions.record(result).catch((error: unknown) => { logger.error('Could not record the result of a call that ran', { auditId, tool: entry.tool, outcome: entry.outcome, error }) })
      else await options.actions.record(result)
      if (gate.denial) announceDenial({ options, entry, denial: gate.denial })
      reportEntry({ options, entry, denial: gate.denial })
      return response
    },
  }
}

/** Every attempt is recorded, so a refusal leaves as much evidence as a success. */
function buildEntry(input: {
  request: InvokeRequest
  sessionId: string
  effects: ResolvedEffect[]
  gate: GateOutcome
  /** The standing grants the call relied on, at the gate and mid-call. */
  grantUses: GrantUse[]
  response: InvokeResponse
  durationMs: number
  /** Answered with an earlier run's outcome: nothing ran for this attempt. */
  replayed: boolean
}): ActionLogEntry {
  const { request, response, gate } = input
  const detail = input.replayed ? REPLAYED : describeDetail(response)
  const decidedBy = [...new Set([...gate.decidedBy ?? [], ...input.grantUses.flatMap(use => use.decidedBy === undefined ? [] : [use.decidedBy])])]
  return {
    at: new Date().toISOString(),
    requestId: request.requestId.slice(0, MAX_LOGGED_ID),
    sessionId: input.sessionId.slice(0, MAX_LOGGED_ID),
    tool: request.tool.slice(0, MAX_LOGGED_ID),
    outcome: describeOutcome(response),
    durationMs: input.durationMs,
    effects: [...new Set(input.effects.map(effect => effect.kind))],
    args: redactAuditArguments(request.args),
    ...(gate.asked.length > 0 ? { asked: gate.asked.map(value => value.split(':')[0] ?? 'permission') } : {}),
    ...(gate.approvedBy.length > 0 ? { approvedBy: gate.approvedBy.map(value => value.split(':')[0] ?? 'permission') } : {}),
    ...(decidedBy.length > 0 ? { decidedBy } : {}),
    ...(input.grantUses.length > 0 ? { grantUses: input.grantUses } : {}),
    ...(detail ? { detail } : {}),
  }
}

/** The detail of an attempt answered with an earlier run's outcome, so every replay is in the audit log. */
const REPLAYED = 'REPLAYED'

/** The approval join's key (approval-service.ts): the session, the actor the guard set, and the whole requestId, hashed. */
function executionKey(input: { request: InvokeRequest; sessionId: string }): ExecutionKey {
  const actor = useScopeSafe()?.context.actor
  return { sessionId: input.sessionId, requestId: requestIdKey(input.request.requestId), fingerprint: requestFingerprint(input.request), ...(actor === undefined ? {} : { actor }) }
}

function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter(signal => signal !== undefined)
  return present.length > 1 ? AbortSignal.any(present) : present[0]
}

/** An earlier run's outcome, unless this caller leaves first: then the wait ends as any cancelled call does. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const leave = () => reject(signal.reason)
    signal.addEventListener('abort', leave, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave))
  })
}

/**
 * Audits the dangerously-allowed uses an allowedBy list names, and notes the standing grants it names
 * for the call's entry; a call's auditor writes each rule and subject once.
 */
type UseAuditor = (allowedBy: readonly string[]) => Promise<void>

function useAuditor(input: { options: InvokerOptions; request: InvokeRequest; sessionId: string; grantUses: GrantUseRecorder }): UseAuditor {
  const audited = new Set<string>()
  return (allowedBy) => {
    input.grantUses.note(allowedBy)
    return auditDangerousUses({ ...input, allowedBy, audited })
  }
}

interface GrantUseRecorder {
  /** Looks up, once per rule and subject, the standing grants an allowedBy list names. */
  note(allowedBy: readonly string[]): void
  uses(): GrantUse[]
}

/**
 * The session and always grants a call relied on, read from the store as they stood when used, with the
 * scope and deciding key each record holds (review M4 of the second proof-of-possession re-review). A
 * `once` is the registry's and is named by `decidedBy` as it is spent.
 */
function grantUseRecorder(input: { grants: GrantStore; sessionId: string }): GrantUseRecorder {
  const seen = new Set<string>()
  const found = new Map<string, GrantUse>()
  return {
    note(allowedBy) {
      const fresh = allowedBy.filter(key => !seen.has(key))
      if (fresh.length === 0) return
      for (const key of fresh) seen.add(key)
      const now = Date.now()
      const standing = input.grants.list().filter(grant => !grant.denied && grant.scope !== 'once' && (grant.sessionId === null || grant.sessionId === input.sessionId) && (!grant.expiresAt || Date.parse(grant.expiresAt) > now))
      for (const key of fresh) {
        for (const grant of standing.filter(record => `${record.rule}:${record.subject}` === key)) {
          const use: GrantUse = { rule: grant.rule, scope: grant.scope === 'always' ? 'always' : 'session', ...(grant.decidedBy === undefined ? {} : { decidedBy: grant.decidedBy }) }
          found.set(JSON.stringify(use), use)
        }
      }
    },
    uses: () => [...found.values()],
  }
}

/**
 * Every ask the workspace's dangerously-allow switch let through is audited on its own (ruling 11 of
 * 2026-09-28): an entry per use naming the rule and the redacted subject, a warning in the owner's
 * log, and the same entry in the action report to Rings. The entry is required: a use that cannot be
 * recorded does not go ahead. A rule and subject the call already recorded is not written again.
 */
async function auditDangerousUses(input: { options: InvokerOptions; request: InvokeRequest; sessionId: string; allowedBy: readonly string[]; audited: Set<string> }): Promise<void> {
  const { options, request } = input
  const workspaceId = options.workspaceId ?? 'default'
  for (const use of dangerousUses(input.allowedBy)) {
    const key = JSON.stringify([use.rule, use.subject])
    if (input.audited.has(key)) continue
    const subject = redactedSubject(use.rule, use.subject)
    const at = new Date().toISOString()
    const entry: ActionLogEntry = {
      at, requestId: request.requestId.slice(0, MAX_LOGGED_ID), sessionId: input.sessionId.slice(0, MAX_LOGGED_ID), tool: DANGEROUSLY_ALLOWED_TOOL,
      outcome: 'ok', durationMs: 0, effects: [], args: { tool: request.tool.slice(0, MAX_LOGGED_ID), rule: use.rule, subject }, approvedBy: [DANGEROUSLY_ALLOW], detail: use.rule,
    }
    await options.actions.record({ ...entry, auditId: randomUUID(), event: 'result', workspaceId, ...auditContext(request) })
    input.audited.add(key)
    logger.warn('Dangerously allowed without a person', { workspaceId, tool: request.tool.slice(0, MAX_LOGGED_ID), rule: use.rule })
    if (!options.reporter.configured) continue
    options.reporter.record({
      workspace: options.paths.root, workspaceId, at, requestId: entry.requestId, sessionId: entry.sessionId, tool: DANGEROUSLY_ALLOWED_TOOL,
      outcome: 'ok', durationMs: 0, effects: [], args: entry.args, rule: use.rule, subject, reason: DANGEROUSLY_ALLOWED_REASON,
      asked: [], approvedBy: [DANGEROUSLY_ALLOW], detail: use.rule,
    })
  }
}

const DANGEROUSLY_ALLOWED_TOOL = 'policy_dangerously_allowed'
const DANGEROUSLY_ALLOWED_REASON = 'Allowed without a person by the workspace\'s dangerously-allow switch'

/**
 * Told as it happens, and never awaited: the refusal already stands, and a report endpoint
 * that is slow or down must not hold the caller's answer.
 */
function announceDenial(input: { options: InvokerOptions; entry: ActionLogEntry; denial: NonNullable<GateOutcome['denial']> }): void {
  if (!input.options.reporter.configured) return
  const report: DeniedRunReport = {
    event: 'denied_run',
    serverId: input.options.serverId,
    workspace: input.options.paths.root,
    at: input.entry.at,
    requestId: input.entry.requestId,
    sessionId: input.entry.sessionId,
    tool: input.entry.tool,
    rule: input.denial.rule,
    subject: input.denial.subject,
    reason: input.denial.reason,
    effects: input.entry.effects,
    args: input.entry.args,
  }
  void input.options.reporter.report(report).catch((error: unknown) => {
    logger.warn('Could not report a denied run', { message: error instanceof Error ? error.message : 'Unknown error' })
  })
}

/**
 * The whole action log, not only its refusals, per `BUCKLE-D06: Buckle reports the full action
 * log`. Queued rather than posted: the entry is already in the node's own log, so a batch that
 * never reaches Rings loses nothing.
 */
function reportEntry(input: { options: InvokerOptions; entry: ActionLogEntry; denial: GateOutcome['denial'] }): void {
  if (!input.options.reporter.configured) return
  const { entry, denial } = input
  input.options.reporter.record({
    workspace: input.options.paths.root,
    workspaceId: input.options.workspaceId ?? 'default',
    at: entry.at,
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    tool: entry.tool,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    effects: entry.effects,
    args: entry.args,
    rule: denial?.rule ?? null,
    subject: denial?.subject ?? '',
    reason: denial?.reason ?? '',
    asked: entry.asked ?? [],
    approvedBy: entry.approvedBy ?? [],
    detail: entry.detail ?? null,
  })
}

function describeOutcome(response: InvokeResponse): ActionLogEntry['outcome'] {
  if (response.outcome === 'error' && response.error.code === 'PERMISSION_DENIED') return 'denied'
  return response.outcome
}

function describeDetail(response: InvokeResponse): string | undefined {
  if (response.outcome === 'error') return response.error.code
  return undefined
}

/**
 * Returns a response when the call cannot proceed, an earlier call's outcome when a call of the same
 * key ran or runs, or a null response when it is cleared to run. A cleared call claims the key's one
 * execution (into `held`) under the same lock that spends its `once` approvals, so a re-send racing it
 * finds the execution instead of asking again (review M2 of B20-B22).
 */
async function clearPermissions(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  effects: ResolvedEffect[]
  signal?: AbortSignal
  isCancel?: (reason: unknown) => boolean
  approvalWait?: ApprovalWait
  key: ExecutionKey
  held: { claim?: ExecutionClaim }
}): Promise<GateOutcome> {
  const { options, request, sessionId, effects, held } = input
  const approvedBy: string[] = []
  let consumed: GrantSubject[] = []
  let decidedBy: string[] = []
  const evaluate = (tokens: string[]) => options.approvals.evaluate({
    tokens, sessionId, tool: request.tool, fingerprint: input.key.fingerprint,
    spent: (deciders) => { decidedBy = deciders },
    check: subjects => {
      // The registry's last check carries the approvals the call uses, a superset of earlier ones.
      consumed = subjects
      approvedBy.splice(0, approvedBy.length, ...subjects.map(subject => `${subject.rule}:${subject.subject}`))
      return options.permissions.evaluate({ tool: request.tool, effects, grants: buildLookup({ grants: options.grants, sessionId, consumed: subjects }) })
    },
    admit: () => {
      held.claim = options.executions.claim(input.key)
      return held.claim.kind === 'owner'
    },
  })
  const cleared = (outcome: Extract<PermissionOutcome, { kind: 'allow' }>, asked: string[]): GateOutcome => held.claim?.kind === 'owner'
    ? { response: null, asked, approvedBy: [...new Set([...approvedBy, ...outcome.allowedBy])], consumed, decidedBy }
    : { response: null, asked, approvedBy: [...new Set(approvedBy)], ...(held.claim ? { earlier: held.claim } : {}) }
  const outcome = await evaluate(request.approvalTokens)
  if (outcome.kind === 'allow') return cleared(outcome, [])
  if (outcome.kind === 'deny') {
    return {
      response: denied(request, outcome.denial.reason),
      asked: [`${outcome.denial.rule}:${outcome.denial.subject ?? request.tool}`],
      approvedBy,
      denial: { rule: outcome.denial.rule, subject: outcome.denial.subject, reason: outcome.denial.reason },
    }
  }

  // A re-send of a call that spent its `once` a moment ago: that call is this one (review M2 of B20-B22).
  const sibling = options.executions.earlier(input.key)
  if (sibling) return { response: null, asked: [], approvedBy, earlier: sibling }

  // Every answer, from any route, is recorded by the service; this call only learns whether all came in.
  // The caller's hint travels in the request and overrides the node's own wait (Rings sends none when
  // its policy skips); an entry point may add its own, and the one that holds less wins.
  const wait = shorterWait(input.approvalWait, request.context?.approvalWait)
  // Only the caller's own signal reaches the wait: shutdown settles waits through the service's close.
  const cwd = options.paths.displayRoot
  // The whole call as a person decides on it (owner decision D17): every argument, the directory, the node's
  // summary and the effects the rules judged, redacted and never cut. One too large is refused whole.
  const call = { arguments: reviewableArguments(request.args), cwd, description: describeCall({ tool: request.tool, args: request.args, cwd }), effects: effects.map(summarizeEffect), complete: true as const }
  const waited = await options.approvalService.request({
    sessionId, requestId: requestIdKey(request.requestId), tool: request.tool, asks: outcome.asks, signal: input.signal, ...(input.isCancel ? { isCancel: input.isCancel } : {}), wait,
    fingerprint: input.key.fingerprint, call,
  })
  // A re-send joined to asks already answered has none still waiting: it is told what it asked.
  const approvals = waited.approvals
  const asked = (approvals.length > 0 ? approvals : outcome.asks).map(approval => `${approval.rule}:${approval.subject}`)
  if (waited.superseded) return { response: failed(request, SUPERSEDED), asked, approvedBy }
  if (!waited.settled) {
    return { response: { requestId: request.requestId, outcome: 'approval_required', approvals }, asked, approvedBy }
  }

  const tokens = [...approvals.map(approval => approval.token), ...waited.answered]
  if (options.approvals.wasDenied(tokens)) {
    // The siblings of a denied ask go through the service, so the webhook hears they were cancelled.
    await options.approvalService.withdraw(tokens)
    const described = approvals.length > 0 ? approvals : outcome.asks
    return {
      response: denied(request, 'Approval was declined'),
      asked,
      approvedBy: [...new Set(approvedBy)],
      denial: { rule: described[0]?.rule ?? 'write_scope', subject: described.map(approval => approval.subject).join(', '), reason: 'Approval was declined' },
    }
  }
  const rechecked = await evaluate([...request.approvalTokens, ...tokens])
  if (rechecked.kind === 'allow') return cleared(rechecked, asked)
  // A re-send of this call spent the answer and ran, or runs, while this one waited: it answers this
  // one too, rather than telling the caller nobody answered (review L6 of B23-B25).
  const ranMeanwhile = options.executions.earlier(input.key)
  if (ranMeanwhile) return { response: null, asked, approvedBy: [...new Set(approvedBy)], earlier: ranMeanwhile }
  // Nobody denied it: the asks expired, were withdrawn, or another call spent the `once`. Only a
  // recorded denial is reported as one (review M1).
  return { response: failed(request, UNANSWERED), asked, approvedBy: [...new Set(approvedBy)] }
}

/** How a re-send of a call stopped by an audit failure is answered: retryable, so it runs once the storage is repaired. */
function auditFailed(request: InvokeRequest): InvokeResponse {
  return failed(request, { code: 'AUDIT_UNAVAILABLE', message: 'Buckle could not write its audit log during this call, so it stopped; retry once the owner repairs the audit storage', retryable: true })
}

/** A call whose tool ran but whose record Buckle could not write: it counts as run, effects unknown, never run again under its requestId. */
function ranUnrecorded(code: string): { code: string; message: string; retryable: boolean } {
  return { code, message: 'This call ran, but Buckle could not record it, so its effects are unknown; it is not run again under this requestId: check the workspace, then send a new requestId once the owner repairs the audit storage', retryable: false }
}

const SUPERSEDED = { code: 'REQUEST_SUPERSEDED', message: 'A newer call with the same requestId joined this approval wait and carries it on; this call did not run', retryable: false }
const UNANSWERED = { code: 'APPROVAL_UNANSWERED', message: 'The approval this call waited for expired, was withdrawn or was spent by another call; send the call again to ask again', retryable: true }
const REUSED = { code: REQUEST_ID_REUSED, message: 'This requestId already names a different call from this session; send a new requestId', retryable: false }

function failed(request: InvokeRequest, error: { code: string; message: string; retryable: boolean }): InvokeResponse {
  return { requestId: request.requestId, outcome: 'error', error }
}

function denied(request: InvokeRequest, message: string): InvokeResponse {
  return {
    requestId: request.requestId,
    outcome: 'error',
    error: { code: 'PERMISSION_DENIED', message, retryable: false },
  }
}

function buildLookup(input: {
  grants: GrantStore
  sessionId: string
  consumed: GrantSubject[]
}): GrantLookup {
  return {
    deniedSubjectsFor: rule => deniedSubjects(input.grants, input.sessionId, rule),
    subjectsFor: rule => [
      ...input.grants.activeSubjects({ sessionId: input.sessionId, rule }),
      ...subjectsByRule(input.consumed, rule),
    ],
    // A `once` stays exact, so only standing grants can hold a pattern.
    patternsFor: rule => input.grants.activePatterns({ sessionId: input.sessionId, rule }),
  }
}

async function executeWithTimeout(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  consumed: GrantSubject[]
  /** What the permission check judged; a reader or writer may reach only the targets among them. */
  effects: ResolvedEffect[]
  auditUses: UseAuditor
  signal?: AbortSignal
  execute: (context: ToolContext) => Promise<JsonValue>
}): Promise<JsonValue> {
  const judged = (kind: 'read_path' | 'write_path') => new Set(input.effects.flatMap(effect => effect.kind === kind ? [effect.path] : []))
  const judgedReads = judged('read_path')
  const judgedWrites = judged('write_path')
  const timeoutMs = Math.min(input.request.timeoutMs ?? input.options.defaultTimeoutMs, input.options.maxTimeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await input.execute({
      requestId: input.request.requestId,
      sessionId: input.sessionId,
      stageId: input.request.context?.stageId ?? input.request.context?.runId,
      timeoutMs,
      signal: input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
      authorizeRead: async path => {
        if (!isAbsolute(path)) return false
        const outcome = input.options.permissions.evaluate({
          tool: input.request.tool, effects: [await resolveHostRead(path)],
          grants: buildLookup({ grants: input.options.grants, sessionId: input.sessionId, consumed: input.consumed }),
        })
        if (outcome.kind !== 'allow') return false
        await input.auditUses(outcome.allowedBy)
        return true
      },
      authorizeReadTarget: target => judgedReads.has(target),
      authorizeWrite: target => judgedWrites.has(target),
      judgeNetwork: url => judgeNetwork({ ...input, url }),
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One network effect through the same rules the call cleared, with the grants it cleared with. A
 * host a person approved, or the dangerously-allow switch let through, is `granted`: the fetch skips
 * its reserved-range check for it. A switch use is audited before the hop, and a use that cannot be
 * recorded refuses it (review M3 of B20-B22).
 */
async function judgeNetwork(input: { options: InvokerOptions; request: InvokeRequest; sessionId: string; consumed: GrantSubject[]; auditUses: UseAuditor; url: URL }): Promise<NetworkVerdict> {
  const outcome = input.options.permissions.evaluate({
    tool: input.request.tool,
    effects: [{ kind: 'network', url: input.url }],
    grants: buildLookup({ grants: input.options.grants, sessionId: input.sessionId, consumed: input.consumed }),
  })
  if (outcome.kind === 'deny') return { kind: 'refused', reason: outcome.denial.reason }
  if (outcome.kind === 'ask') return { kind: 'refused', reason: outcome.asks.map(item => item.reason).join('; ') }
  await input.auditUses(outcome.allowedBy)
  const granted = outcome.allowedBy.some(key => key.startsWith('network_egress:')) || dangerousUses(outcome.allowedBy).some(use => use.rule === 'network_egress')
  return granted ? { kind: 'granted' } : { kind: 'allowed' }
}

// Names the limit and nothing the caller sent.
function sessionIdTooLong(request: InvokeRequest): InvokeResponse {
  return { requestId: request.requestId, outcome: 'error', error: { code: 'SESSION_ID_TOO_LONG', message: `The session id is longer than ${MAX_SESSION_ID} characters; send a shorter one`, retryable: false } }
}

function shapeError(error: unknown, tool: string): { code: string; message: string; retryable: boolean } {
  if (error instanceof InvocationsClosedError) return { code: 'BUCKLE_SHUTTING_DOWN', message: 'Buckle shut down during this call and cancelled it; if it had started, its effects are unknown', retryable: false }
  if (error instanceof ToolInputError) return { code: error.code, message: error.message, retryable: false }
  if (error instanceof ToolExecutionError) return { code: error.code, message: error.message, retryable: error.retryable }
  if (error instanceof ApprovalConflictError) return { code: 'APPROVAL_CONFLICT', message: error.message, retryable: false }
  if (error instanceof RequestIdReusedError) return { code: REQUEST_ID_REUSED, message: error.message, retryable: false }
  if (error instanceof ApprovalLimitError) return { code: 'APPROVAL_LIMIT', message: error.message, retryable: true }
  if (error instanceof ActionTooLargeError) return { code: error.code, message: error.message, retryable: false }
  if (isStateBusy(error)) {
    logger.warn('Tool invocation found Buckle state busy', { tool, message: error.message })
    return { code: 'STATE_BUSY', message: STATE_BUSY_MESSAGE, retryable: true }
  }
  logger.error('Tool invocation failed', {
    tool,
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return { code: 'TOOL_EXECUTION_FAILED', message: 'Tool invocation failed', retryable: false }
}

function inferTruncated(output: unknown): boolean {
  return typeof output === 'object' && output !== null && 'truncated' in output && output.truncated === true
}

function auditContext(request: InvokeRequest): Pick<ActionLogEntry, 'runId' | 'stageId' | 'chatId' | 'projectId' | 'actorId' | 'agentId'> {
  const context = request.context
  return {
    runId: context?.runId?.slice(0, MAX_LOGGED_ID), stageId: context?.stageId?.slice(0, MAX_LOGGED_ID),
    chatId: context?.chatId?.slice(0, MAX_LOGGED_ID), projectId: context?.projectId?.slice(0, MAX_LOGGED_ID),
    actorId: context?.actorId?.slice(0, MAX_LOGGED_ID), agentId: context?.agentId?.slice(0, MAX_LOGGED_ID),
  }
}
