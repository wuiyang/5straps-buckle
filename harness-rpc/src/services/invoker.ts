import type { InvokeRequest, InvokeResponse, JsonValue } from '@5straps/protocol'
import { summarizeEffect, type ResolvedEffect } from '../domain/effect.js'
import type { PermissionEngine } from '../domain/permission/engine.js'
import type { GrantLookup } from '../domain/permission/decision.js'
import { redactArguments } from '../domain/redact.js'
import type { ToolRegistry } from '../domain/tool-registry.js'
import { ToolExecutionError, ToolInputError, type ToolContext } from '../domain/tool.js'
import type { ActionLog, ActionLogEntry } from '../ports/action-log.js'
import type { ApprovalChannel } from '../ports/approval-channel.js'
import type { GrantStore } from '../ports/grant-store.js'
import { logger } from '../logger.js'
import { resolveEffects } from './resolve-effects.js'
import { subjectsByRule, type ApprovalRegistry } from './approval-registry.js'

export interface InvokerOptions {
  registry: ToolRegistry
  permissions: PermissionEngine
  approvals: ApprovalRegistry
  grants: GrantStore
  channel: ApprovalChannel
  actions: ActionLog
  cwd: string
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

export interface Invoker {
  invoke(input: { request: InvokeRequest; sessionId: string }): Promise<InvokeResponse>
}

/** What the permission step decided, carried through so the action log can report the reason. */
interface GateOutcome {
  response: InvokeResponse | null
  asked: string[]
  approvedBy: string[]
}

export function createInvoker(options: InvokerOptions): Invoker {
  return {
    async invoke({ request, sessionId }) {
      const startedAt = performance.now()
      let effects: ResolvedEffect[] = []
      let gate: GateOutcome = { response: null, asked: [], approvedBy: [] }

      const response = await (async (): Promise<InvokeResponse> => {
        try {
          const prepared = options.registry.get(request.tool).prepare(request.args)
          effects = await resolveEffects({ effects: prepared.effects, cwd: options.cwd })

          gate = await clearPermissions({ options, request, sessionId, effects })
          if (gate.response) return gate.response

          const output = await executeWithTimeout({ options, request, sessionId, execute: prepared.execute })
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

      options.actions.record(buildEntry({
        request,
        sessionId,
        effects,
        gate,
        response,
        durationMs: Math.round(performance.now() - startedAt),
      }))
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
    requestId: request.requestId,
    sessionId: input.sessionId,
    tool: request.tool,
    outcome: describeOutcome(response),
    durationMs: input.durationMs,
    effects: input.effects.map(summarizeEffect),
    args: redactArguments(request.args),
    ...(gate.asked.length > 0 ? { asked: gate.asked } : {}),
    ...(gate.approvedBy.length > 0 ? { approvedBy: gate.approvedBy } : {}),
    ...(describeDetail(response) ? { detail: describeDetail(response) } : {}),
  }
}

function describeOutcome(response: InvokeResponse): ActionLogEntry['outcome'] {
  if (response.outcome === 'error' && response.error.code === 'PERMISSION_DENIED') return 'denied'
  return response.outcome
}

function describeDetail(response: InvokeResponse): string | undefined {
  if (response.outcome === 'error') return `${response.error.code}: ${response.error.message}`
  return undefined
}

/** Returns a response when the call cannot proceed, or a null response when it is cleared to run. */
async function clearPermissions(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  effects: ResolvedEffect[]
}): Promise<GateOutcome> {
  const { options, request, sessionId, effects } = input
  const consumed = options.approvals.consume(request.approvalTokens)
  const approvedBy = consumed.map(subject => `${subject.rule}:${subject.subject}`)
  const lookup = buildLookup({ grants: options.grants, sessionId, consumed })

  const outcome = options.permissions.evaluate({ tool: request.tool, effects, grants: lookup })
  if (outcome.kind === 'allow') return { response: null, asked: [], approvedBy: [...approvedBy, ...outcome.allowedBy] }
  if (outcome.kind === 'deny') {
    return {
      response: {
        requestId: request.requestId,
        outcome: 'error',
        error: { code: 'PERMISSION_DENIED', message: outcome.denial.reason, retryable: false },
      },
      asked: [`${outcome.denial.rule}:${outcome.denial.subject ?? request.tool}`],
      approvedBy,
    }
  }

  const approvals = options.approvals.issue({ tool: request.tool, sessionId, asks: outcome.asks })
  const asked = approvals.map(approval => `${approval.rule}:${approval.subject}`)
  const decisions = await options.channel.request(approvals)
  if (!decisions) {
    return { response: { requestId: request.requestId, outcome: 'approval_required', approvals }, asked, approvedBy }
  }

  for (const decision of decisions) {
    const result = options.approvals.resolve(decision)
    if (!result.ok) logger.warn('Approval decision rejected', { reason: result.reason })
  }

  const granted = options.approvals.consume(approvals.map(approval => approval.token))
  const rechecked = options.permissions.evaluate({
    tool: request.tool,
    effects,
    grants: buildLookup({ grants: options.grants, sessionId, consumed: [...consumed, ...granted] }),
  })
  const resolvedBy = [...approvedBy, ...granted.map(subject => `${subject.rule}:${subject.subject}`)]
  if (rechecked.kind === 'allow') {
    return { response: null, asked, approvedBy: [...new Set([...resolvedBy, ...rechecked.allowedBy])] }
  }

  return {
    response: {
      requestId: request.requestId,
      outcome: 'error',
      error: { code: 'PERMISSION_DENIED', message: 'Approval was declined', retryable: false },
    },
    asked,
    approvedBy: resolvedBy,
  }
}

function buildLookup(input: {
  grants: GrantStore
  sessionId: string
  consumed: ReturnType<ApprovalRegistry['consume']>
}): GrantLookup {
  return {
    subjectsFor: rule => [
      ...input.grants.activeSubjects({ sessionId: input.sessionId, rule }),
      ...subjectsByRule(input.consumed, rule),
    ],
  }
}

async function executeWithTimeout(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  execute: (context: ToolContext) => Promise<JsonValue>
}): Promise<JsonValue> {
  const timeoutMs = Math.min(input.request.timeoutMs ?? input.options.defaultTimeoutMs, input.options.maxTimeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await input.execute({
      requestId: input.request.requestId,
      sessionId: input.sessionId,
      timeoutMs,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
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
