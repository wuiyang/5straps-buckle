import { deniedSubjects } from '../../adapters/grant-store/file-grant-store.js'
import { randomUUID } from 'node:crypto'
import { useScopeSafe } from '@5straps/runtime'
import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChangeHistory } from '../history/journal.js'
import type { ApprovalWait, DeniedRunReport, InvokeRequest, InvokeResponse, JsonValue, PermissionRuleId, GrantSubject } from '@5straps/protocol'
import { type ResolvedEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import type { PermissionEngine } from '../../domain/permission/engine.js'
import type { GrantLookup } from '../../domain/permission/decision.js'
import { redactAuditArguments } from '../../domain/redact.js'
import type { ToolRegistry } from '../../domain/tool-registry.js'
import { ToolExecutionError, ToolInputError, type NetworkVerdict, type ToolContext } from '../../domain/tool.js'
import type { ActionLog, ActionLogEntry } from '../../types/ports/action-log.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import type { Reporter } from '../../types/ports/reporter.js'
import { logger } from '../../runtime/log.js'
import { resolveEffects } from './resolve-effects.js'
import { isStateBusy, STATE_BUSY_MESSAGE } from '../state-busy.js'
import { ApprovalConflictError, ApprovalLimitError, subjectsByRule, type ApprovalRegistry } from '../approvals/approval-registry.js'
import { shorterWait, type ApprovalService } from '../approvals/approval-service.js'
import { requestFingerprint, REQUEST_ID_REUSED, type Earlier, type Execution, type ExecutionKey, type Executions } from './executions.js'

/** The audit log's bound on caller-chosen ids; the stored join key is held to it too (review L4). */
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
}

export interface InvokeInput {
  request: InvokeRequest
  sessionId: string
  signal?: AbortSignal
  /** How long the caller will wait for an approval; it can only shorten the entry point's own hold. */
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
}

export function createInvoker(options: InvokerOptions): Invoker {
  return {
    async invoke({ request, sessionId, signal, approvalWait }) {
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
      let execution: Execution | undefined
      let replayed = false
      const answerEarlier = (earlier: Earlier): Promise<InvokeResponse> | InvokeResponse => {
        if (earlier.kind === 'reused') return failed(request, REUSED)
        replayed = true
        return untilAborted(earlier.response, signal)
      }

      const response = await (async (): Promise<InvokeResponse> => {
        try {
          signal?.throwIfAborted()
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

          gate = await clearPermissions({ options, request, sessionId, effects, signal, approvalWait })
          signal?.throwIfAborted()
          if (gate.response) return gate.response

          // Cleared: this call becomes the key's one execution, unless a re-send of it got there first.
          const claim = options.executions.claim(key)
          if (claim.kind !== 'owner') return await answerEarlier(claim)
          const owned = execution = claim.execution
          const execute = () => {
            owned.started()
            return executeWithTimeout({ options, request, sessionId, signal, consumed: gate.consumed ?? [], execute: prepared.execute })
          }
          const writes = effects.filter(effect => effect.kind === 'write_path')
          const roots = [...options.historyRoots ?? [], ...writes.map(effect => { let path = effect.path; while (!existsSync(path)) path = dirname(path); return realpathSync(path) })]
          const tracksChanges = writes.length > 0 || effects.some(effect => effect.kind === 'exec') && request.tool !== 'browser_command'
          const output = options.history && tracksChanges && !prepared.managesHistory
            ? await options.history.run({ sessionId, stageId: request.context?.stageId ?? request.context?.runId ?? request.requestId, tool: request.tool, roots: [...new Set(roots)] }, execute, signal)
            : await execute()
          return {
            requestId: request.requestId,
            outcome: 'ok',
            output,
            meta: { durationMs: Math.round(performance.now() - startedAt), truncated: inferTruncated(output) },
          }
        } catch (error) {
          return { requestId: request.requestId, outcome: 'error', error: shapeError(error, request.tool) }
        }
      })()
      // Settled before the result is recorded: the tool ran whether or not the record can be written.
      execution?.settle({ response, auditId, callerLeft: signal?.aborted === true })

      const entry = buildEntry({
        request,
        sessionId,
        effects,
        gate,
        response,
        durationMs: Math.round(performance.now() - startedAt),
        replayed,
      })
      await options.actions.record({ ...entry, auditId, event: 'result', workspaceId: options.workspaceId ?? 'default',
        ...auditContext(request),

      })
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
  response: InvokeResponse
  durationMs: number
  /** Answered with an earlier run's outcome: nothing ran for this attempt. */
  replayed: boolean
}): ActionLogEntry {
  const { request, response, gate } = input
  const detail = input.replayed ? REPLAYED : describeDetail(response)
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
    ...(detail ? { detail } : {}),
  }
}

/** The detail of an attempt answered with an earlier run's outcome, so every replay is in the audit log. */
const REPLAYED = 'REPLAYED'

/** The approval join's key (approval-service.ts): the session, the actor the guard set, and the requestId as the log bounds it. */
function executionKey(input: { request: InvokeRequest; sessionId: string }): ExecutionKey {
  const actor = useScopeSafe()?.context.actor
  return { sessionId: input.sessionId, requestId: input.request.requestId.slice(0, MAX_LOGGED_ID), fingerprint: requestFingerprint(input.request), ...(actor === undefined ? {} : { actor }) }
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

/** Returns a response when the call cannot proceed, or a null response when it is cleared to run. */
async function clearPermissions(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  effects: ResolvedEffect[]
  signal?: AbortSignal
  approvalWait?: ApprovalWait
}): Promise<GateOutcome> {
  const { options, request, sessionId, effects } = input
  const approvedBy: string[] = []
  let consumed: GrantSubject[] = []
  const evaluate = (tokens: string[]) => options.approvals.evaluate({
    tokens, sessionId, tool: request.tool,
    check: subjects => {
      // The registry's last check carries the approvals the call uses, a superset of earlier ones.
      consumed = subjects
      approvedBy.splice(0, approvedBy.length, ...subjects.map(subject => `${subject.rule}:${subject.subject}`))
      return options.permissions.evaluate({ tool: request.tool, effects, grants: buildLookup({ grants: options.grants, sessionId, consumed: subjects }) })
    },
  })
  const outcome = await evaluate(request.approvalTokens)
  if (outcome.kind === 'allow') return { response: null, asked: [], approvedBy: [...approvedBy, ...outcome.allowedBy], consumed }
  if (outcome.kind === 'deny') {
    return {
      response: denied(request, outcome.denial.reason),
      asked: [`${outcome.denial.rule}:${outcome.denial.subject ?? request.tool}`],
      approvedBy,
      denial: { rule: outcome.denial.rule, subject: outcome.denial.subject, reason: outcome.denial.reason },
    }
  }

  // Every answer, from any route, is recorded by the service; this call only learns whether all came in.
  // The caller's hint travels in the request (Rings sends none when its policy skips); the face may add its own.
  const wait = shorterWait(input.approvalWait, request.context?.approvalWait)
  const waited = await options.approvalService.request({ sessionId, requestId: request.requestId.slice(0, MAX_LOGGED_ID), tool: request.tool, asks: outcome.asks, signal: input.signal, wait })
  const { approvals } = waited
  const asked = approvals.map(approval => `${approval.rule}:${approval.subject}`)
  if (waited.superseded) return { response: failed(request, SUPERSEDED), asked, approvedBy }
  if (!waited.settled) {
    return { response: { requestId: request.requestId, outcome: 'approval_required', approvals }, asked, approvedBy }
  }

  const tokens = [...approvals.map(approval => approval.token), ...waited.answered]
  if (options.approvals.wasDenied(tokens)) {
    // The siblings of a denied ask go through the service, so the webhook hears they were cancelled.
    await options.approvalService.withdraw(tokens)
    const first = approvals[0]
    return {
      response: denied(request, 'Approval was declined'),
      asked,
      approvedBy: [...new Set(approvedBy)],
      denial: { rule: first?.rule ?? 'write_scope', subject: approvals.map(approval => approval.subject).join(', '), reason: 'Approval was declined' },
    }
  }
  const rechecked = await evaluate([...request.approvalTokens, ...tokens])
  if (rechecked.kind === 'allow') {
    return { response: null, asked, approvedBy: [...new Set([...approvedBy, ...rechecked.allowedBy])], consumed }
  }
  // Nobody denied it: the asks expired, were withdrawn, or another call spent the `once`. Only a
  // recorded denial is reported as one (review M1).
  return { response: failed(request, UNANSWERED), asked, approvedBy: [...new Set(approvedBy)] }
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
  signal?: AbortSignal
  execute: (context: ToolContext) => Promise<JsonValue>
}): Promise<JsonValue> {
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
        const effects = await resolveEffects({ effects: [{ kind: 'read_path', path }], paths: input.options.paths })
        return input.options.permissions.evaluate({
          tool: input.request.tool, effects,
          grants: buildLookup({ grants: input.options.grants, sessionId: input.sessionId, consumed: input.consumed }),
        }).kind === 'allow'
      },
      judgeNetwork: url => judgeNetwork({ ...input, url }),
    })
  } finally {
    clearTimeout(timer)
  }
}

/** One network effect through the same rules the call cleared, with the grants it cleared with. */
function judgeNetwork(input: { options: InvokerOptions; request: InvokeRequest; sessionId: string; consumed: GrantSubject[]; url: URL }): NetworkVerdict {
  const outcome = input.options.permissions.evaluate({
    tool: input.request.tool,
    effects: [{ kind: 'network', url: input.url }],
    grants: buildLookup({ grants: input.options.grants, sessionId: input.sessionId, consumed: input.consumed }),
  })
  if (outcome.kind === 'deny') return { kind: 'refused', reason: outcome.denial.reason }
  if (outcome.kind === 'ask') return { kind: 'refused', reason: outcome.asks.map(item => item.reason).join('; ') }
  return outcome.allowedBy.some(key => key.startsWith('network_egress:')) ? { kind: 'granted' } : { kind: 'allowed' }
}

// Names the limit and nothing the caller sent.
function sessionIdTooLong(request: InvokeRequest): InvokeResponse {
  return { requestId: request.requestId, outcome: 'error', error: { code: 'SESSION_ID_TOO_LONG', message: `The session id is longer than ${MAX_SESSION_ID} characters; send a shorter one`, retryable: false } }
}

function shapeError(error: unknown, tool: string): { code: string; message: string; retryable: boolean } {
  if (error instanceof ToolInputError) return { code: error.code, message: error.message, retryable: false }
  if (error instanceof ToolExecutionError) return { code: error.code, message: error.message, retryable: error.retryable }
  if (error instanceof ApprovalConflictError) return { code: 'APPROVAL_CONFLICT', message: error.message, retryable: false }
  if (error instanceof ApprovalLimitError) return { code: 'APPROVAL_LIMIT', message: error.message, retryable: true }
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
