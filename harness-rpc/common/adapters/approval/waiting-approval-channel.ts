import { setTimeout as sleep } from 'node:timers/promises'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { logger } from '../../runtime/log.js'
import type { ApprovalChannel } from '../../types/ports/approval-channel.js'
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js'

const POLL_INTERVAL_MS = 400

export interface WaitingApprovalOptions {
  approvals: ApprovalRegistry
  /** Milliseconds to hold a call, null for no deadline, or zero for immediate fallback. */
  timeoutMs: number | null
  /** Told once that a decision is wanted, so a person can be reached away from the machine. */
  notify?: (requests: ApprovalRequest[]) => Promise<void>
  /** Asked directly when this process has a terminal to ask in. */
  prompt?: ApprovalChannel
}

/**
 * Holds a gated call open for a grace period rather than refusing it at once, so an approval
 * arriving by any route lands in time: a y/n in this terminal, `buckle approve` elsewhere, a POST
 * to /setup/approvals, or whatever a webhook put in front of the person.
 *
 * An out-of-band approval resolves the token itself, so this returns an empty decision list
 * rather than a decision to apply. The caller then re-evaluates against the grant that now exists.
 *
 * The grace period bounds the call, not the question. When it ends the call reports back, and the
 * terminal keeps asking until the request expires or another route answers it; an answer given
 * there afterwards is recorded like any other, so the retried call finds it.
 */
export function createWaitingApprovalChannel(options: WaitingApprovalOptions): ApprovalChannel {
  return {
    id: 'waiting',
    async request(requests, signal) {
      signal?.throwIfAborted()
      await announce(options.notify, requests)
      signal?.throwIfAborted()
      if (options.timeoutMs === 0) return null

      const controller = new AbortController()
      const cancelled = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const prompted = promptOrWait(options.prompt, requests, cancelled)
      let keepPrompt = false
      try {
        const decided = await Promise.race([prompted, waitForResolution(options.approvals, requests, options.timeoutMs, cancelled)])
        signal?.throwIfAborted()
        if (decided === null && options.prompt) {
          keepPrompt = true
          keepAsking({ approvals: options.approvals, requests, prompted, controller })
        }
        return decided
      } finally {
        if (!keepPrompt) controller.abort()
      }
    },
  }
}

/**
 * After the grace period: records what the terminal answers, and lets go of the terminal once
 * every token leaves the pending set, which is how an answer elsewhere or an expiry shows.
 */
function keepAsking(input: {
  approvals: ApprovalRegistry
  requests: ApprovalRequest[]
  prompted: Promise<ApprovalDecision[] | null>
  controller: AbortController
}): void {
  void input.prompted.then(decisions => {
    for (const decision of decisions ?? []) {
      const result = input.approvals.resolve(decision)
      if (!result.ok) logger.warn('Approval decision rejected', { reason: result.reason })
    }
  })
  const untilExpiry = Math.max(...input.requests.map(request => Date.parse(request.expiresAt) - Date.now()), 0)
  void waitForResolution(input.approvals, input.requests, untilExpiry).then(() => input.controller.abort())
}

async function announce(
  notify: WaitingApprovalOptions['notify'],
  requests: ApprovalRequest[],
): Promise<void> {
  if (!notify) return
  try {
    await notify(requests)
  } catch (error) {
    // Failing to reach someone must not also fail the call they would have approved.
    logger.warn('Could not announce a pending approval', {
      message: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Never settles when there is no terminal, or when the prompt gives up, so the grace period
 * rather than the prompt decides when waiting ends.
 */
function promptOrWait(
  prompt: ApprovalChannel | undefined,
  requests: ApprovalRequest[],
  signal: AbortSignal,
): Promise<ApprovalDecision[] | null> {
  if (!prompt) return new Promise(() => {})
  return prompt.request(requests, signal).then(decisions => decisions ?? new Promise<never>(() => {}))
}

/** Watches for the tokens to leave the pending set, which is how any other route reports back. */
async function waitForResolution(
  approvals: ApprovalRegistry,
  requests: ApprovalRequest[],
  timeoutMs: number | null,
  signal?: AbortSignal,
): Promise<ApprovalDecision[] | null> {
  const tokens = requests.map(request => request.token)
  const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), undefined, { signal })
    const pending = new Set(approvals.pending().map(request => request.token))
    if (approvals.wasDenied(tokens) || tokens.every(token => !pending.has(token))) return []
  }
  return null
}
