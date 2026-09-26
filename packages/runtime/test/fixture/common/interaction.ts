import { randomUUID } from 'node:crypto'
import { useScope, type CliOutcome, type CliRequest, type RequestCli } from '@5straps/runtime'
import type { ApprovalQueue } from './approvals.js'

export interface AskOwnerInput {
  summary: string
  timeoutMs?: number
  requestCli: RequestCli
  approvals: ApprovalQueue
  signal?: AbortSignal
}

// Shared by HTTP and MCP: build the request from the current scope, wait for the CLI, and queue
// durably when nobody can answer. An unavailable CLI is never an approval (coordination.md).
export async function askOwner(input: AskOwnerInput): Promise<CliOutcome> {
  const request = buildRequest(input)
  const outcome = await input.requestCli(request, { signal: input.signal })
  if (outcome.status !== 'unavailable' || outcome.pending) return outcome
  return { ...outcome, pending: await input.approvals.persist(request) }
}

function buildRequest(input: AskOwnerInput): CliRequest {
  const { context } = useScope()
  return {
    id: randomUUID(),
    kind: 'approval',
    correlationId: context.correlationId,
    ...(context.actor ? { actor: context.actor } : {}),
    action: { summary: input.summary },
    wait: input.timeoutMs === undefined ? { mode: 'indefinite' } : { mode: 'finite', timeoutMs: input.timeoutMs },
  }
}
