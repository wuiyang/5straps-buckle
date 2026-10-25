import { deniedSubjects } from '../../adapters/grant-store/file-grant-store.js'
import { randomUUID } from 'node:crypto'
import { useScopeSafe } from '@5straps/runtime'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'pathe'
import type { ChangeHistory } from '../history/journal.js'
import type { ApprovalWait, DeniedRunReport, InvokeRequest, InvokeResponse, JsonValue, PermissionRuleId, GrantSubject } from '@5straps/protocol'
import { summarizeEffect, type ResolvedEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import type { PermissionEngine, PermissionOutcome } from '../../domain/permission/engine.js'
import type { GrantLookup } from '../../domain/permission/decision.js'
import { redactAuditArguments, reviewableArguments } from '../../domain/redact.js'
import { describeCall } from '../../domain/describe-call.js'
import { DANGEROUSLY_ALLOW, dangerousUses, redactedSubject } from '../../domain/permission/rules/dangerously-allow.js'
import { CODE_CHANGED_REASON, CodeChangedError, JUDGE, passKey, QUICK_FLAG_REASON, withFlagged, withJudged, type CodeBinding } from '../../domain/permission/judged.js'
import { announcePass, judgeAuditOf, judgeNotes, withJudgeReason, type JudgedAsk, type JudgeGate } from '../judge/judge-gate.js'
import { AUDIT_UNAVAILABLE, AuditUnavailableError } from '../../adapters/action-log/file-action-log.js'
import type { ToolRegistry } from '../../domain/tool-registry.js'
import { CODE_REPLAY_DIVERGED, LockWaitError, NestedApprovalRequired, ScriptEndedError, ToolExecutionError, ToolInputError, type NestedCall, type NetworkVerdict, type ToolContext } from '../../domain/tool.js'
import type { ActionLog, ActionLogEntry, GrantUse } from '../../types/ports/action-log.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import type { Reporter } from '../../types/ports/reporter.js'
import { logger } from '../../runtime/log.js'
import { resolveEffects, resolveHostRead } from './resolve-effects.js'
import { isStateBusy, STATE_BUSY_MESSAGE } from '../state-busy.js'
import { ActionTooLargeError, ApprovalConflictError, ApprovalLimitError, RequestIdReusedError, subjectsByRule, type ApprovalRegistry } from '../approvals/approval-registry.js'
import { shorterWait, type ApprovalService } from '../approvals/approval-service.js'
import { nestedCallKey, requestFingerprint, requestIdKey, REQUEST_ID_REUSED, type Earlier, type ExecutionClaim, type ExecutionKey, type Executions } from './executions.js'
import { nativePath, parentDirectory } from '../../domain/paths.js'
import { secretPlanOf, type SecretSettings } from '../secrets/places.js'
import { secretFileEffects } from '../secrets/secret-file.js'

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
  /**
   * The roots a write's checkpoint and the execution lock cover, read just before the call runs (checkpointRoots),
   * which refuses where the workspace's folder changed on disk since it was registered.
   */
  historyRoots?: () => string[]
  /**
   * Refuses, by throwing, where the workspace's folder is gone or was swapped for a link since it was registered (fix
   * brief 6, item 2): checked before a call is judged, and again after any approval, just before it runs, a script's
   * calls included, as its mounts' sources are checked at each use.
   */
  checkFolder?: () => void
  actions: ActionLog
  reporter: Reporter
  /** The workspace's decision AI as the call found it (D91): in automated mode it may pass a command ask its stages cover. */
  judge?: JudgeGate
  /** The workspace's secret reference settings as the call found them (docs/secrets.md); on where absent. */
  secrets?: SecretSettings
  paths: PathView
  serverId: string
  workspaceId: string
  defaultTimeoutMs: number
  maxTimeoutMs: number
  toolDenial?(tool: string): string | null
  /**
   * The runtime's shutdown (B19): cancels a running tool and refuses calls that arrive later, but is
   * never the caller leaving, so an approval wait it ends leaves the asks pending (review L6 of B18-B19).
   */
  shutdown?: AbortSignal
  /**
   * How a script's call runs (owner decision D82): through the workspace runtime's own invoke, so it is counted,
   * cancelled at shutdown, and judged against this workspace alone. This invoker's own when absent.
   */
  nested?: (input: InvokeInput) => Promise<InvokeResponse>
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
  /**
   * Set only by the invoker on a call a script made (owner decision D82): the outer call's tool and requestId, which
   * the ask names so the approver can find the script in the audit log, and which refuses a code tool.
   */
  via?: NestedOrigin
  /**
   * Set only by the invoker on a call a script made: when its approval wait must end at the latest, on the
   * `performance.now()` clock, the script's deadline less a margin, read by the approval service just before it waits
   * (review of the code-mode slice, finding approvals-replay 685; re-review, finding fixes-hold invoker.ts:712).
   */
  holdUntil?: number
  /** Set only by the invoker on a call a script made: told when the tool begins to run (NestedCall.onExecute). */
  onExecute?: () => void
}

/**
 * The call a script's call came from: its tool, and the requestId of the `code_run` call whose script made it, which
 * the call's audit entries carry as `parentRequestId` and its change history is grouped under where the caller named
 * no stage or run. The stage itself stays the caller's own (final review of 0.1.4, finding invoker 701).
 */
export interface NestedOrigin {
  tool: string
  parentRequestId: string
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
  const invoker: Invoker = {
    async invoke({ request, sessionId, signal, isCancel, approvalWait, via, holdUntil, onExecute }) {
      const startedAt = performance.now()
      const auditId = randomUUID()
      // A required audit write that fails stops the call here, before anything runs (data.md).
      await options.actions.record(attemptEntry({ auditId, workspaceId: options.workspaceId, request, sessionId, via }))
      let effects: ResolvedEffect[] = []
      let gate: GateOutcome = { response: null, asked: [], approvedBy: [] }
      // A re-send is the same call when it comes from the same session and actor (review M2 of B13-B14).
      const key = executionKey({ request, sessionId })
      // The key's one execution, once the gate claims it; settled below whatever happens after.
      const held: { claim?: ExecutionClaim } = {}
      // What the decision AI said of the call's command asks, for its audit entry (D91), and the onces the thorough stage
      // gave on request that this call may spend, with the subjects whose bound code changed since (fix brief 9, B31).
      const judgment: Judgment = { judged: [], codes: [], stale: new Set() }
      let replayed = false
      let ran = false
      // The caller leaving or the runtime shutting down: either stops a running tool.
      const stop = anySignal(signal, options.shutdown)
      // One entry per rule and subject a call's dangerously-allowed uses name, however often it meets them (review L12 of B20-B22).
      const grantUses = grantUseRecorder({ grants: options.grants, sessionId })
      const auditUses = useAuditor({ options, request, sessionId, grantUses })
      const answerEarlier = async (earlier: Earlier): Promise<InvokeResponse> => {
        // A script cannot send a new requestId: it is told to change the script (review of the code-mode slice, finding invoker-audit 134).
        if (earlier.kind === 'reused') return failed(request, via ? SCRIPT_CALL_REUSED : REUSED)
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
          // Scripts cannot start scripts (owner decision D82, point 3), whatever name a script reaches them by.
          const refusal = reason ?? (via && options.registry.has(request.tool) && options.registry.get(request.tool).outsideScripts ? SCRIPT_REFUSAL : null)
          if (refusal) {
            const response = denied(request, refusal)
            gate = { response, asked: [], approvedBy: [], denial: { rule: 'tool_policy', subject: request.tool, reason: refusal } }
            return response
          }
          options.checkFolder?.()
          const tool = options.registry.get(request.tool)
          const prepared = tool.prepare(request.args)
          // A reference is read in shell words, browser fill values, and web_fetch headers, and refused anywhere else,
          // before anything is judged; each file the references name is judged where it lands, and its first use asks a
          // person (docs/secrets.md).
          const secretPlan = secretPlanOf({ tool: request.tool, pack: tool.capability.pack, args: request.args, enabled: options.secrets?.enabled ?? true })
          effects = [...await resolveEffects({ effects: prepared.effects, paths: options.paths }), ...secretPlan ? secretFileEffects(secretPlan, options.paths) : []]

          // A tool that takes the write lock itself runs its program in a copy of the workspace's folder (the isolated shell).
          const fromCopy = prepared.managesHistory === true
          gate = await clearPermissions({ options, request, sessionId, effects, fromCopy, signal, isCancel, approvalWait, holdUntil, key, held, judgment, via })
          // A script's call whose ask was recorded only as its script ended, behind a slow approvals lock, is still an
          // ask: it answers approval_required, which the pack hands back, never the script's end (re-check of round 2,
          // finding deadline-announce invoker.ts:175).
          if (!(via && gate.response?.outcome === 'approval_required')) stop?.throwIfAborted()
          if (gate.earlier) return await answerEarlier(gate.earlier)
          if (gate.response) return gate.response
          // Cleared: the gate claimed this key's one execution as it spent the call's approvals.
          if (held.claim?.kind !== 'owner') throw new Error('A cleared call holds no execution claim')
          const owned = held.claim.execution
          await auditUses(gate.approvedBy)
          // The folder may have changed while the call waited for its approval: nothing runs where it lands now.
          options.checkFolder?.()
          // The tool begins to run once. A pass of the decision AI, and a once its thorough stage gave on request, binds to
          // the code it rated: that code is read again under the write lock, just before the program starts, and where it
          // changed nothing runs and a person decides (fix brief 9, B31). A tool that takes the lock itself, the isolated
          // shell, is handed the check to call once its copy of the workspace is taken.
          let begun = false
          const markStarted = () => {
            if (begun) return
            begun = true
            owned.started()
            ran = true
            onExecute?.()
          }
          const beginRun = () => {
            if (begun) return
            const changed = changedCode({ options, judgment, call: { effects, tool: request.tool, args: request.args, fromCopy } })
            if (changed.length > 0) throw new CodeChangedError(changed)
            markStarted()
          }
          const execute = async () => {
            if (!prepared.managesHistory) beginRun()
            // A script's calls are named by what its tool says names it (code_run: the script), not every argument.
            const nestingKey = prepared.replayKey ? { ...key, fingerprint: requestFingerprint({ tool: request.tool, args: prepared.replayKey }) } : key
            const nesting = prepared.reachesTools ? { run: options.nested ?? invoker.invoke, key: nestingKey, callerSignal: signal, isCancel, approvalWait } : undefined
            try {
              const output = await executeWithTimeout({ options, request, sessionId, signal: stop, consumed: gate.consumed ?? [], effects, auditUses, execute: prepared.execute, timeoutMs: prepared.timeoutMs, nesting, via, ...(prepared.managesHistory ? { beginRun } : {}) })
              markStarted()
              return output
            } catch (error) {
              // A tool that failed past the check, or never reached it, counts as run, as every tool did before the check;
              // one whose own wait for the write lock ended before the check ran nothing, as when the invoker's wait ends
              // (D91 follow-ups, F4 residue).
              if (!(error instanceof CodeChangedError || error instanceof LockWaitError)) markStarted()
              throw error
            }
          }
          const writes = effects.filter(effect => effect.kind === 'write_path')
          const roots = [...options.historyRoots?.() ?? [], ...writes.map(effect => { let path = effect.path; while (!existsSync(path) && parentDirectory(path) !== path) path = parentDirectory(path); return nativePath(realpathSync(path)) })]
          const tracksChanges = writes.length > 0 || effects.some(effect => effect.kind === 'exec') && request.tool !== 'browser_command'
          // A write is checkpointed under the workspace's write lock; an exclusive call that writes nothing history
          // keeps runs under the same lock without a checkpoint, so no write lands while it runs (review H3).
          const output = options.history && tracksChanges && !prepared.managesHistory
            ? await options.history.run({ sessionId, stageId: historyStage(request, via), tool: request.tool, roots: [...new Set(roots)] }, execute, stop)
            : options.history && prepared.exclusive ? await options.history.exclusive(execute, stop) : await execute()
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
          // The code a pass rated changed before the program started: nothing ran, so the claim is settled unstarted (a
          // re-send asks again) and the asks the passes lifted go to a person with the reason (fix brief 9, B31).
          if (error instanceof CodeChangedError && !ran && !options.shutdown?.aborted) {
            const after = await askAfterChange({ options, request, sessionId, effects, judgment, subjects: error.subjects, key, via, ...(signal ? { signal } : {}), ...(isCancel ? { isCancel } : {}) })
            const lifted = new Set(error.subjects.map(subject => `${JUDGE}:destructive_command:${subject}`))
            gate = { ...gate, asked: after.asked, approvedBy: gate.approvedBy.filter(item => !lifted.has(item)) }
            return after.response
          }
          // A script whose call needs a person answers as that call would (owner decision D82, point 6): the asks are the
          // nested call's own, recorded whole by it, and the outer call is audited as approval_required.
          if (error instanceof NestedApprovalRequired && !options.shutdown?.aborted) {
            gate = { ...gate, asked: error.approvals.map(approval => `${approval.rule}:${approval.subject}`) }
            return { requestId: request.requestId, outcome: 'approval_required', approvals: error.approvals }
          }
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
        if (held.claim?.kind === 'owner') held.claim.execution.settle({ response: answered ?? (ran ? failed(request, ranUnrecorded(AUDIT_UNAVAILABLE)) : auditFailed(request)), auditId, callerLeft: signal?.aborted === true, ...(via ? { script: true } : {}) })
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
        judge: judgeAuditOf(judgment.judged),
      })
      const result = { ...entry, auditId, event: 'result' as const, workspaceId: options.workspaceId, ...auditContext(request, via) }
      // A call that ran answers with what it did even when its result cannot be written: refusing it
      // would tell the caller it did not run, and a retry would run it twice (review L5 of B18-B19). The
      // attempt is already in the log, and recovery marks it interrupted.
      if (ran) await options.actions.record(result).catch((error: unknown) => { logger.error('Could not record the result of a call that ran', { auditId, tool: entry.tool, outcome: entry.outcome, error }) })
      else await options.actions.record(result)
      if (gate.denial) announceDenial({ options, entry, denial: gate.denial })
      reportEntry({ options, entry: result, denial: gate.denial })
      return response
    },
  }
  return invoker
}

/** The line a call writes before it is judged: who asked for what, with its arguments redacted. */
function attemptEntry(input: { auditId: string; workspaceId: string; request: InvokeRequest; sessionId: string; via?: NestedOrigin | undefined }): ActionLogEntry {
  const { request } = input
  return {
    auditId: input.auditId, event: 'attempt', workspaceId: input.workspaceId,
    at: new Date().toISOString(), requestId: request.requestId.slice(0, MAX_LOGGED_ID), sessionId: input.sessionId.slice(0, MAX_LOGGED_ID),
    tool: request.tool.slice(0, MAX_LOGGED_ID), outcome: 'started', durationMs: 0, effects: [], args: redactAuditArguments(request.args),
    ...auditContext(request, input.via),
  }
}

/**
 * A call refused before it reaches the invoker, because the workspace is offline or a settings change waits for active
 * work, leaves the pair every call leaves: an attempt, and a result of outcome `error` whose detail is the refusal's
 * code, shaped as the invoker's own entries. A required write, as the invoker's attempt is: where the log refuses it
 * the refusal is the log's.
 */
export async function recordRefusedCall(input: { actions: ActionLog; workspaceId: string; call: Pick<InvokeInput, 'request' | 'sessionId'>; code: string }): Promise<void> {
  const attempt = attemptEntry({ auditId: randomUUID(), workspaceId: input.workspaceId, request: input.call.request, sessionId: input.call.sessionId })
  await input.actions.record(attempt)
  await input.actions.record({ ...attempt, event: 'result', at: new Date().toISOString(), outcome: 'error', detail: input.code })
}

/** Said to a script that names a code tool (owner decision D82, point 3). */
const SCRIPT_REFUSAL = 'Scripts cannot start scripts: code_run and code_api are not called from a script'

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
  judge: ActionLogEntry['judge']
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
    ...(input.judge ? { judge: input.judge } : {}),
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
  const workspaceId = options.workspaceId
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
    workspaceId: input.options.workspaceId,
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
    // The attribution the node's own entry keeps (GPT review of c71dee5, reported audit fields): who decided,
    // which standing grants it used, who the transport authenticated, and who the caller claims to be.
    ...(entry.decidedBy ? { decidedBy: entry.decidedBy } : {}),
    ...(entry.grantUses ? { grantUses: entry.grantUses } : {}),
    ...(entry.actorId && entry.actorTrust ? { actor: { id: entry.actorId, trust: entry.actorTrust } } : {}),
    ...(entry.claimedActorId ? { claimedActorId: entry.claimedActorId } : {}),
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
  /** The call's program runs in a copy of the workspace's folder, which the decision AI is told (judge-gate.ts CallView). */
  fromCopy: boolean
  effects: ResolvedEffect[]
  signal?: AbortSignal
  isCancel?: (reason: unknown) => boolean
  approvalWait?: ApprovalWait
  holdUntil?: number
  key: ExecutionKey
  held: { claim?: ExecutionClaim }
  judgment: Judgment
  via?: NestedOrigin
}): Promise<GateOutcome> {
  const { options, request, sessionId, effects, held } = input
  const approvedBy: string[] = []
  let consumed: GrantSubject[] = []
  let decidedBy: string[] = []
  // The asks a stage of the decision AI passed (D91), taken out at every check once it rated them, so an answer to the
  // call's other asks never asks about them again.
  let passed: ReadonlySet<string> = new Set()
  // The allowed commands the quick stage rated danger at 0.8 or above (approval.quickJudge all), each an ask at every check.
  let flagged: Array<Extract<PermissionOutcome, { kind: 'ask' }>['asks'][number]> = []
  const evaluate = (tokens: string[]) => options.approvals.evaluate({
    tokens, sessionId, tool: request.tool, fingerprint: input.key.fingerprint,
    spent: (deciders) => { decidedBy = deciders },
    // A once the thorough stage gave on request is spent only while the code it rated is the code this call would run;
    // the run reads it again before the program starts (fix brief 9, B31).
    holds: (subject, code) => {
      const holds = subject.rule === 'destructive_command' && (options.judge?.holds(code, { effects, tool: request.tool, args: request.args, subject: subject.subject, fromCopy: input.fromCopy }) ?? false)
      if (!holds) input.judgment.stale.add(subject.subject)
      else if (!input.judgment.codes.some(item => item.subject === subject.subject && item.binding.key === code.key)) input.judgment.codes.push({ subject: subject.subject, binding: code })
      return holds
    },
    check: subjects => {
      // The registry's last check carries the approvals the call uses, a superset of earlier ones.
      consumed = subjects
      approvedBy.splice(0, approvedBy.length, ...subjects.map(subject => `${subject.rule}:${subject.subject}`))
      const grants = buildLookup({ grants: options.grants, sessionId, consumed: subjects })
      return withJudged(withFlagged(options.permissions.evaluate({ tool: request.tool, effects, grants }), flagged, grants), passed)
    },
    admit: () => {
      held.claim = options.executions.claim(input.key)
      return held.claim.kind === 'owner'
    },
  })
  const cleared = (outcome: Extract<PermissionOutcome, { kind: 'allow' }>, asked: string[]): GateOutcome => held.claim?.kind === 'owner'
    ? { response: null, asked, approvedBy: [...new Set([...approvedBy, ...outcome.allowedBy])], consumed, decidedBy }
    : { response: null, asked, approvedBy: [...new Set(approvedBy)], ...(held.claim ? { earlier: held.claim } : {}) }
  const judging = options.judge?.mode === 'automated' && options.judge.ready ? options.judge : undefined
  // Scope all (D91, addendum 2 B): before the first check, which admits an allowed call, the quick stage rates each command
  // no ask names; a danger at 0.8 or above makes it an ask, and anything else, no verdict included, lets it run as before.
  // Never past a deny; the gate screens nothing while the dangerously-allow switch is on.
  if (judging?.screens) {
    const before = options.permissions.evaluate({ tool: request.tool, effects, grants: buildLookup({ grants: options.grants, sessionId, consumed: [] }) })
    if (before.kind !== 'deny') {
      const asked = new Set(before.kind === 'ask' ? before.asks.filter(item => item.rule === 'destructive_command').map(item => item.subject) : [])
      input.judgment.judged = await judging.screen({ asked, effects, tool: request.tool, args: request.args, fromCopy: input.fromCopy, ...(input.signal ? { signal: input.signal } : {}) })
      flagged = input.judgment.judged.filter(item => item.flagged).map(item => ({ kind: 'ask' as const, rule: 'destructive_command' as const, subject: item.subject, reason: QUICK_FLAG_REASON, offeredScopes: ['once' as const, 'session' as const], cause: 'judge' as const }))
    }
  }
  let outcome = await evaluate(request.approvalTokens)
  // In automated mode the decision AI rates the command asks its stages cover, once per call and outside every lock
  // (D91 and its addenda): a deny returned above, and the dangerously-allow switch already turned what it covers. What a
  // stage passes, the check above takes out, so the call is checked again with them gone.
  if (judging && outcome.kind === 'ask' && outcome.asks.some(ask => judging.covers(ask))) {
    input.judgment.judged = [...input.judgment.judged, ...await judging.rate({ asks: outcome.asks, effects, tool: request.tool, args: request.args, fromCopy: input.fromCopy, ...(input.signal ? { signal: input.signal } : {}) })]
    passed = new Set(input.judgment.judged.filter(item => item.passedBy !== undefined).map(passKey))
    if (passed.size > 0) outcome = await evaluate(request.approvalTokens)
    // Announced once the call is checked again, so the line says whether it now runs or still waits (fix brief 2, H9).
    if (outcome.kind !== 'deny') {
      const waitingFor = outcome.kind === 'ask' ? outcome.asks.map(ask => ask.rule) : []
      for (const item of input.judgment.judged) if (item.passedBy !== undefined) announcePass(item, waitingFor)
    }
  }
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
  // A script's call says so, and names the stage the audit log groups the script's calls under (owner decision D82).
  // What the decision AI said, or that it rates on request, beside the whole action, and its level in the reason an agent reads (D91).
  const judge = judgeNotes({ gate: options.judge, asks: outcome.asks, judged: input.judgment.judged })
  const call = { arguments: reviewableArguments(request.args), cwd, description: describeCall({ tool: request.tool, args: request.args, cwd, ...(input.via ? { via: input.via } : {}) }), effects: effects.map(summarizeEffect), complete: true as const, ...(judge.length > 0 ? { judge } : {}) }
  const waited = await options.approvalService.request({
    sessionId, requestId: requestIdKey(request.requestId), tool: request.tool, asks: outcome.asks.map(ask => withStaleReason(withJudgeReason(ask, input.judgment.judged), input.judgment.stale)), signal: input.signal, ...(input.isCancel ? { isCancel: input.isCancel } : {}), wait,
    ...(input.holdUntil === undefined ? {} : { holdUntil: input.holdUntil }), fingerprint: input.key.fingerprint, call,
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

/**
 * What a call learns of the decision AI as its permissions clear (D91): the ratings for its audit entry, the onces the
 * thorough stage gave on request that it may spend with the code each binds to, and the subjects of such onces whose code
 * changed since, which a person then decides (fix brief 9, B31).
 */
interface Judgment {
  judged: JudgedAsk[]
  codes: Array<{ subject: string; binding: CodeBinding }>
  stale: Set<string>
}

/**
 * The commands whose rated code is no longer the code the call would run (fix brief 9, B31): each a stage passed in
 * automated mode, and each with a once the thorough stage gave on request, read again through the gate's view. A pass
 * with no binding fails closed.
 */
function changedCode(input: { options: InvokerOptions; judgment: Judgment; call: { effects: readonly ResolvedEffect[]; tool: string; args: InvokeRequest['args']; fromCopy: boolean } }): string[] {
  const gate = input.options.judge
  const passes = input.judgment.judged.filter(item => item.passedBy !== undefined)
  const bound = [...passes.map(item => ({ subject: item.subject, binding: item.bound })), ...input.judgment.codes]
  const changed = bound.filter(({ subject, binding }) => binding === undefined || !(gate?.holds(binding, { ...input.call, subject }) ?? false))
  return [...new Set(changed.map(item => item.subject))]
}

/** An ask whose once the thorough stage gave on request no longer covers the code: its reason says so (fix brief 9, B31). */
function withStaleReason<A extends { subject: string; reason: string }>(ask: A, stale: ReadonlySet<string>): A {
  return stale.has(ask.subject) && !ask.reason.includes(CODE_CHANGED_REASON) ? { ...ask, reason: `${ask.reason}; ${CODE_CHANGED_REASON}` } : ask
}

/** What a call answers when the code a pass rated changed and no ask is left to put to a person. */
const CODE_CHANGED = { code: 'CODE_CHANGED_AFTER_RATING', message: 'The code changed after the decision AI rated it, so this call did not run; send it again and it is asked about anew', retryable: true }

/**
 * The asks a pass lifted, put to a person once the code it rated changed before the program started (fix brief 9, B31):
 * each changed command's rating stays as it was with its pass taken away (`changed`), and its ask, as the rules make it
 * with no grant spent, waits with the reason, answered at once with approval_required, whatever wait the call asked for,
 * since nothing runs in this call. A re-send with the token runs once a person approves it.
 */
async function askAfterChange(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  effects: ResolvedEffect[]
  judgment: Judgment
  subjects: readonly string[]
  key: ExecutionKey
  signal?: AbortSignal
  isCancel?: (reason: unknown) => boolean
  via?: NestedOrigin
}): Promise<{ response: InvokeResponse; asked: string[] }> {
  const { options, request, sessionId, effects, judgment } = input
  const changed = new Set(input.subjects)
  judgment.judged = judgment.judged.map(item => {
    if (!changed.has(item.subject) || item.passedBy === undefined) return item
    const { passedBy: _passedBy, bound: _bound, ...rest } = item
    return { ...rest, changed: true as const }
  })
  for (const subject of changed) judgment.stale.add(subject)
  const outcome = options.permissions.evaluate({ tool: request.tool, effects, grants: buildLookup({ grants: options.grants, sessionId, consumed: [] }) })
  const asks = outcome.kind === 'ask' ? outcome.asks.filter(ask => ask.rule === 'destructive_command' && changed.has(ask.subject)) : []
  if (asks.length === 0) return { response: failed(request, CODE_CHANGED), asked: [] }
  const cwd = options.paths.displayRoot
  const judge = judgeNotes({ gate: options.judge, asks, judged: judgment.judged })
  const call = { arguments: reviewableArguments(request.args), cwd, description: describeCall({ tool: request.tool, args: request.args, cwd, ...(input.via ? { via: input.via } : {}) }), effects: effects.map(summarizeEffect), complete: true as const, ...(judge.length > 0 ? { judge } : {}) }
  const waited = await options.approvalService.request({
    sessionId, requestId: requestIdKey(request.requestId), tool: request.tool, asks: asks.map(ask => withStaleReason(withJudgeReason(ask, judgment.judged), judgment.stale)),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.isCancel ? { isCancel: input.isCancel } : {}), wait: { mode: 'none' }, fingerprint: input.key.fingerprint, call,
  })
  return { response: { requestId: request.requestId, outcome: 'approval_required', approvals: waited.approvals }, asked: waited.approvals.map(approval => `${approval.rule}:${approval.subject}`) }
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
const SCRIPT_CALL_REUSED = { code: CODE_REPLAY_DIVERGED, message: 'This script ran lately and made another call at this point then; Buckle does not mix the two runs. Change the script, even by a comment, to run it from its start', retryable: false }

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
  /** The call's own limit from its input (PreparedCall.timeoutMs), within the node's maximum. */
  timeoutMs?: number
  /** For a tool that reaches tools: how its calls run, and what of this call they inherit. */
  nesting?: Nesting
  /** For a call a script made: the call that sent the script, which its history stage falls back to. */
  via?: NestedOrigin
  /**
   * For a tool that takes the write lock itself: the check it calls just before its program starts (ToolContext.beginRun),
   * handed beside its wait for that lock outside the timer (ToolContext.untimed).
   */
  beginRun?: () => void
}): Promise<JsonValue> {
  const judged = (kind: 'read_path' | 'write_path') => new Set(input.effects.flatMap(effect => effect.kind === kind ? [effect.path] : []))
  const judgedReads = judged('read_path')
  const judgedWrites = judged('write_path')
  const timeoutMs = Math.min(input.timeoutMs ?? input.request.timeoutMs ?? input.options.defaultTimeoutMs, input.options.maxTimeoutMs)
  const controller = new AbortController()
  // A script's own deadline ends it first and reads as a timeout; this one only backs it (owner decision D82).
  // Past a script's deadline the script has ended: a call of its that hears this backstop before the pack's own cancel,
  // as when the main thread stalls across both, is cut for that reason too, and audited SCRIPT_ENDED (re-check of
  // round 3, finding late-ask-audit invoker.ts:635).
  const expire = () => controller.abort(input.nesting ? new ScriptEndedError() : undefined)
  let left = input.nesting ? timeoutMs + NESTED_DEADLINE_GRACE_MS : timeoutMs
  let armedAt = performance.now()
  let timer = setTimeout(expire, left)
  let ended = false
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal
  // A tool's own wait for the write lock is not timed, as the invoker's wait and its checkpoint are not: the timer stops
  // for it and goes on with the time it had left, so a long write neither fails the call nor shortens its run (D91
  // follow-ups, F4 residue). A call already cut waits for nothing.
  const untimed = async <T>(wait: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    clearTimeout(timer)
    left -= performance.now() - armedAt
    try { return await wait(input.signal) } finally {
      armedAt = performance.now()
      if (!ended) timer = setTimeout(expire, Math.max(0, left))
    }
  }
  try {
    return await input.execute({
      requestId: input.request.requestId,
      sessionId: input.sessionId,
      stageId: input.request.context?.stageId ?? input.request.context?.runId,
      // A tool that checkpoints its own changes, the isolated shell, files them where the invoker files a write, so a
      // script's shell and file changes share one stage (recheck of the final review of 0.1.4, finding shell index.ts:151).
      historyStage: historyStage(input.request, input.via),
      timeoutMs,
      signal,
      ...(input.beginRun ? { beginRun: input.beginRun, untimed } : {}),
      ...(input.nesting ? nestedContext({ ...input, nesting: input.nesting, signal, timeoutMs }) : {}),
      authorizeRead: async path => {
        if (!isAbsolute(path)) return false
        // A path its resolution refuses, such as a link onto a root folder named like a drive, is unreachable: it is
        // hidden as any other unreachable entry is, never a failure of the whole listing or search it is in.
        const effect = await resolveHostRead(path, input.options.paths.shares).catch((error: unknown) => { if (error instanceof ToolInputError) return null; throw error })
        if (effect === null) return false
        const outcome = input.options.permissions.evaluate({
          tool: input.request.tool, effects: [effect],
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
    ended = true
    clearTimeout(timer)
  }
}

/** How long the invoker's timer waits past a script's own deadline before it cancels the call itself. */
const NESTED_DEADLINE_GRACE_MS = 1_000
/** How long before a script's deadline the approval wait of a call it made ends, so the call answers approval_required. */
const NESTED_WAIT_MARGIN_MS = 1_000

/** What a tool that reaches tools is handed to make its calls with, and what of the outer call they keep. */
interface Nesting {
  run: (input: InvokeInput) => Promise<InvokeResponse>
  key: ExecutionKey
  /** The outer caller's own signal, without the shutdown or the timer: only its cancel withdraws a nested ask. */
  callerSignal?: AbortSignal
  /** The outer caller's cancel test and its wait for a person, which every nested call keeps. */
  isCancel?: (reason: unknown) => boolean
  approvalWait?: ApprovalWait
}

/**
 * A script's calls, each built here from the outer call and never by the tool (owner decision D82, point 4): the
 * same session and actor scope, the outer call's approval tokens, its context as it came, its wait for a person, and
 * its signal. The context's stage is the caller's own, unset where it named none, so a script's calls reach the same
 * browser sessions and every other state kept by session and stage as the agent's direct calls: a page the agent
 * opened is the page a script reads. The script is named beside it instead, by the outer call's requestId as
 * `parentRequestId`, which the audit log and the change history group a script's calls by (final review of 0.1.4,
 * finding invoker 701). The requestId is `code:<key>:<call number>`, the key a hash of the session, the actor and
 * the outer call, so a re-sent script names its calls as before: Buckle's own re-send dedupe never runs one twice,
 * and a call that asked joins its ask.
 */
function nestedContext(input: { options: InvokerOptions; request: InvokeRequest; sessionId: string; nesting: Nesting; signal: AbortSignal; timeoutMs: number }): Pick<ToolContext, 'invokeNested' | 'nestedKey' | 'nestedParent' | 'forgetNested' | 'withdrawNested' | 'callerCancelled'> {
  const { request, nesting } = input
  const nestedKey = nestedCallKey(nesting.key)
  const nestedParent = request.requestId.slice(0, MAX_LOGGED_ID)
  const requestIdOf = (id: number) => `code:${nestedKey}:${id}`
  // Only the outer caller's own cancel withdraws a script's asks. The script's deadline, its end, and a shutdown are
  // Buckle's own aborts: an ask they cut stays pending for the re-sent script to join (review of the code-mode
  // slice, finding approvals-replay 685).
  const { callerSignal, isCancel } = nesting
  const cancels = isCancel ? () => callerSignal?.aborted === true && isCancel(callerSignal.reason) : undefined
  // Each wait ends before the script's deadline, so an unanswered ask comes back as approval_required, never as a
  // timeout that leaves it pending unannounced (same finding, and invoker-audit 228).
  const waitEnds = performance.now() + input.timeoutMs - NESTED_WAIT_MARGIN_MS
  const parentOf = (call: NestedCall) => (call.parentRequestId ?? nestedParent).slice(0, MAX_LOGGED_ID)
  return {
    nestedKey,
    nestedParent,
    invokeNested: (call: NestedCall) => nesting.run({
      request: { requestId: requestIdOf(call.id), tool: call.tool, args: call.args, approvalTokens: request.approvalTokens, ...(request.context ? { context: request.context } : {}) },
      sessionId: input.sessionId,
      // The pack's own cancel first: a signal read late reports the first of its sources that aborted, in this order,
      // so a call its script's end cut is audited SCRIPT_ENDED even after the invoker's backstop timer has fired too
      // (re-check of round 2, finding deadline-announce invoker.ts:712).
      signal: call.signal ? AbortSignal.any([call.signal, input.signal]) : input.signal,
      ...(cancels ? { isCancel: cancels } : {}),
      ...(nesting.approvalWait ? { approvalWait: nesting.approvalWait } : {}),
      holdUntil: waitEnds,
      ...(call.onExecute ? { onExecute: call.onExecute } : {}),
      via: { tool: request.tool, parentRequestId: parentOf(call) },
    }),
    forgetNested: (ids) => {
      for (const id of ids) input.options.executions.forget({ ...nesting.key, requestId: requestIdKey(requestIdOf(id)) })
    },
    withdrawNested: tokens => input.options.approvalService.withdraw([...tokens]),
    callerCancelled: () => cancels?.() ?? false,
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
  // A tool's own wait for the write lock answers as the invoker's wait would: a busy lock as busy state, to retry.
  if (error instanceof LockWaitError) return shapeError(error.cause, tool)
  if (error instanceof InvocationsClosedError) return { code: 'BUCKLE_SHUTTING_DOWN', message: 'Buckle shut down during this call and cancelled it; if it had started, its effects are unknown', retryable: false }
  if (error instanceof ScriptEndedError) return { code: error.code, message: error.message, retryable: false }
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

/**
 * A call's attribution for its audit entries: the actor its transport authenticated (the one the execution
 * key joins under), trust authenticated, and the requester the caller claims in its context, trust claimed,
 * beside it and never in its place (GPT review of c71dee5, requester attribution). The run, stage, chat,
 * project and agent are the caller's correlation fields, as it sent them.
 */
function auditContext(request: InvokeRequest, via?: NestedOrigin): Pick<ActionLogEntry, 'runId' | 'stageId' | 'chatId' | 'projectId' | 'actorId' | 'actorTrust' | 'claimedActorId' | 'claimedActorTrust' | 'agentId' | 'parentRequestId'> {
  const context = request.context
  const actor = useScopeSafe()?.context.actor
  const claimed = context?.actorId?.slice(0, MAX_LOGGED_ID)
  return {
    runId: context?.runId?.slice(0, MAX_LOGGED_ID), stageId: context?.stageId?.slice(0, MAX_LOGGED_ID),
    chatId: context?.chatId?.slice(0, MAX_LOGGED_ID), projectId: context?.projectId?.slice(0, MAX_LOGGED_ID),
    agentId: context?.agentId?.slice(0, MAX_LOGGED_ID),
    ...(actor ? { actorId: actor.slice(0, MAX_LOGGED_ID), actorTrust: 'authenticated' as const } : {}),
    ...(claimed ? { claimedActorId: claimed, claimedActorTrust: 'claimed' as const } : {}),
    // A script's call names the code_run call whose script made it (final review of 0.1.4, finding invoker 701).
    ...(via ? { parentRequestId: via.parentRequestId } : {}),
  }
}

/**
 * The stage a call's writes are checkpointed under: the caller's stage, or its run, or else, for a script's call, the
 * code_run call whose script made it, so a script's writes are restored together; a direct call's own requestId last
 * (final review of 0.1.4, finding invoker 701).
 */
function historyStage(request: InvokeRequest, via: NestedOrigin | undefined): string {
  return request.context?.stageId ?? request.context?.runId ?? via?.parentRequestId ?? request.requestId
}
