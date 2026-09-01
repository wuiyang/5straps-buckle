import type { InvokeRequest, InvokeResponse, JsonValue } from '@5straps/protocol'
import type { PermissionEngine } from '../domain/permission/engine.js'
import type { GrantLookup } from '../domain/permission/decision.js'
import type { ToolRegistry } from '../domain/tool-registry.js'
import { ToolExecutionError, ToolInputError, type ToolContext } from '../domain/tool.js'
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
  cwd: string
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

export interface Invoker {
  invoke(input: { request: InvokeRequest; sessionId: string }): Promise<InvokeResponse>
}

export function createInvoker(options: InvokerOptions): Invoker {
  return {
    async invoke({ request, sessionId }) {
      const startedAt = performance.now()
      try {
        const prepared = options.registry.get(request.tool).prepare(request.args)
        const effects = await resolveEffects({ effects: prepared.effects, cwd: options.cwd })

        const gate = await clearPermissions({ options, request, sessionId, effects })
        if (gate) return gate

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
    },
  }
}

/** Returns a response when the call cannot proceed, or null when it is cleared to run. */
async function clearPermissions(input: {
  options: InvokerOptions
  request: InvokeRequest
  sessionId: string
  effects: Awaited<ReturnType<typeof resolveEffects>>
}): Promise<InvokeResponse | null> {
  const { options, request, sessionId, effects } = input
  const consumed = options.approvals.consume(request.approvalTokens)
  const lookup = buildLookup({ grants: options.grants, sessionId, consumed })

  const outcome = options.permissions.evaluate({ tool: request.tool, effects, grants: lookup })
  if (outcome.kind === 'allow') return null
  if (outcome.kind === 'deny') {
    return {
      requestId: request.requestId,
      outcome: 'error',
      error: { code: 'PERMISSION_DENIED', message: outcome.denial.reason, retryable: false },
    }
  }

  const approvals = options.approvals.issue({ tool: request.tool, sessionId, asks: outcome.asks })
  const decisions = await options.channel.request(approvals)
  if (!decisions) {
    return { requestId: request.requestId, outcome: 'approval_required', approvals }
  }

  for (const decision of decisions) {
    const result = options.approvals.resolve(decision)
    if (!result.ok) logger.warn('Approval decision rejected', { reason: result.reason })
  }

  const rechecked = options.permissions.evaluate({
    tool: request.tool,
    effects,
    grants: buildLookup({
      grants: options.grants,
      sessionId,
      consumed: [...consumed, ...options.approvals.consume(approvals.map(approval => approval.token))],
    }),
  })
  if (rechecked.kind === 'allow') return null

  return {
    requestId: request.requestId,
    outcome: 'error',
    error: { code: 'PERMISSION_DENIED', message: 'Approval was declined', retryable: false },
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
