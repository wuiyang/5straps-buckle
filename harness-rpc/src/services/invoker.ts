import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChangeHistory } from './history/journal.js'
import type { ApprovalDecision, DeniedRunReport, InvokeRequest, InvokeResponse, JsonValue, PermissionRuleId, GrantSubject } from '@5straps/protocol'
import { type ResolvedEffect } from '../domain/effect.js'
import type { PathView } from '../domain/path-view.js'
import type { PermissionEngine } from '../domain/permission/engine.js'
import type { GrantLookup } from '../domain/permission/decision.js'
import { redactAuditArguments } from '../domain/redact.js'
import type { ToolRegistry } from '../domain/tool-registry.js'
import { ToolExecutionError, ToolInputError, type NetworkVerdict, type ToolContext } from '../domain/tool.js'
import type { ActionLog, ActionLogEntry } from '../ports/action-log.js'
import type { ApprovalChannel } from '../ports/approval-channel.js'
import type { GrantStore } from '../ports/grant-store.js'
import type { Reporter } from '../ports/reporter.js'
import { logger } from '../logger.js'
import { resolveEffects } from './resolve-effects.js'
import { subjectsByRule, type ApprovalRegistry } from './approval-registry.js'

export interface InvokerOptions {
  registry: ToolRegistry
  permissions: PermissionEngine
  approvals: ApprovalRegistry
  grants: GrantStore
  channel: ApprovalChannel
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

export interface Invoker {
  invoke(input: { request: InvokeRequest; sessionId: string; signal?: AbortSignal }): Promise<InvokeResponse>
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
    async invoke({ request, sessionId, signal }) {
      const startedAt = performance.now()
      const auditId = randomUUID()
      options.actions.record({
        auditId, event: 'attempt', workspaceId: options.workspaceId ?? 'default',
        at: new Date().toISOString(), requestId: request.requestId.slice(0, 200), sessionId: sessionId.slice(0, 200),
        tool: request.tool.slice(0, 200), outcome: 'started', durationMs: 0, effects: [], args: redactAuditArguments(request.args),
        ...auditContext(request),

      })
      let effects: ResolvedEffect[] = []
      let gate: GateOutcome = { response: null, asked: [], approvedBy: [] }

      const response = await (async (): Promise<InvokeResponse> => {
        try {
          signal?.throwIfAborted()
          const reason = options.toolDenial?.(request.tool)
          if (reason) {
            const response = denied(request, reason)
            gate = { response, asked: [], approvedBy: [], denial: { rule: 'tool_policy', subject: request.tool, reason } }
            return response
          }
          const prepared = options.registry.get(request.tool).prepare(request.args)
          effects = await resolveEffects({ effects: prepared.effects, paths: options.paths })

          gate = await clearPermissions({ options, request, sessionId, effects, signal })
          signal?.throwIfAborted()
          if (gate.response) return gate.response

          const execute = () => executeWithTimeout({ options, request, sessionId, signal, consumed: gate.consumed ?? [], execute: prepared.execute })
          const writes = effects.filter(effect => effect.kind === 'write_path')
          const roots = [...options.historyRoots ?? [], ...writes.map(effect => { let path = effect.path; while (!existsSync(path)) path = dirname(path); return realpathSync(path) })]
          const tracksChanges = writes.length > 0 || effects.some(effect => effect.kind === 'exec') && request.tool !== 'browser_command'
          const output = options.history && tracksChanges && !prepared.managesHistory
            ? await options.history.run({ sessionId, stageId: request.context?.stageId ?? request.context?.runId ?? request.requestId, tool: request.tool, roots: [...new Set(roots)] }, execute)
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

      const entry = buildEntry({
        request,
        sessionId,
        effects,
        gate,
        response,
        durationMs: Math.round(performance.now() - startedAt),
      })
      options.actions.record({ ...entry, auditId, event: 'result', workspaceId: options.workspaceId ?? 'default',
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
}): ActionLogEntry {
  const { request, response, gate } = input
  return {
    at: new Date().toISOString(),
    requestId: request.requestId.slice(0, 200),
    sessionId: input.sessionId.slice(0, 200),
    tool: request.tool.slice(0, 200),
    outcome: describeOutcome(response),
    durationMs: input.durationMs,
    effects: [...new Set(input.effects.map(effect => effect.kind))],
    args: redactAuditArguments(request.args),
    ...(gate.asked.length > 0 ? { asked: gate.asked.map(value => value.split(':')[0] ?? 'permission') } : {}),
    ...(gate.approvedBy.length > 0 ? { approvedBy: gate.approvedBy.map(value => value.split(':')[0] ?? 'permission') } : {}),
    ...(describeDetail(response) ? { detail: describeDetail(response) } : {}),
  }
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
  const outcome = evaluate(request.approvalTokens)
  if (outcome.kind === 'allow') return { response: null, asked: [], approvedBy: [...approvedBy, ...outcome.allowedBy], consumed }
  if (outcome.kind === 'deny') {
    return {
      response: denied(request, outcome.denial.reason),
      asked: [`${outcome.denial.rule}:${outcome.denial.subject ?? request.tool}`],
      approvedBy,
      denial: { rule: outcome.denial.rule, subject: outcome.denial.subject, reason: outcome.denial.reason },
    }
  }

  const approvals = options.approvals.issue({ tool: request.tool, sessionId, asks: outcome.asks })
  const asked = approvals.map(approval => `${approval.rule}:${approval.subject}`)
  let decisions: ApprovalDecision[] | null
  try {
    decisions = await options.channel.request(approvals, input.signal)
    input.signal?.throwIfAborted()
  } catch (error) {
    options.approvals.cancel(approvals.map(approval => approval.token))
    throw error
  }
  if (!decisions) {
    return { response: { requestId: request.requestId, outcome: 'approval_required', approvals }, asked, approvedBy }
  }

  for (const decision of decisions) {
    const result = options.approvals.resolve(decision)
    if (!result.ok) logger.warn('Approval decision rejected', { reason: result.reason })
  }

  const tokens = approvals.map(approval => approval.token)
  const wasDenied = options.approvals.wasDenied(tokens)
  if (wasDenied) options.approvals.cancel(tokens)
  const rechecked = wasDenied ? { kind: 'deny' as const } : evaluate([...request.approvalTokens, ...tokens])
  const resolvedBy = [...new Set(approvedBy)]
  if (rechecked.kind === 'allow') {
    return { response: null, asked, approvedBy: [...new Set([...resolvedBy, ...rechecked.allowedBy])], consumed }
  }

  const first = approvals[0]
  return {
    response: denied(request, 'Approval was declined'),
    asked,
    approvedBy: resolvedBy,
    denial: {
      rule: first?.rule ?? 'write_scope',
      subject: approvals.map(approval => approval.subject).join(', '),
      reason: 'Approval was declined',
    },
  }
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
          grants: buildLookup({ grants: input.options.grants, sessionId: input.sessionId, consumed: [] }),
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

function shapeError(error: unknown, tool: string): { code: string; message: string; retryable: boolean } {
  if (error instanceof ToolInputError) return { code: error.code, message: error.message, retryable: false }
  if (error instanceof ToolExecutionError) return { code: error.code, message: error.message, retryable: error.retryable }
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
    runId: context?.runId?.slice(0, 200), stageId: context?.stageId?.slice(0, 200),
    chatId: context?.chatId?.slice(0, 200), projectId: context?.projectId?.slice(0, 200),
    actorId: context?.actorId?.slice(0, 200), agentId: context?.agentId?.slice(0, 200),
  }
}
