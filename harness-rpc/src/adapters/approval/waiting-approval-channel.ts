import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { logger } from '../../logger.js'
import type { ApprovalChannel } from '../../ports/approval-channel.js'
import type { ApprovalRegistry } from '../../services/approval-registry.js'

const POLL_INTERVAL_MS = 400

export interface WaitingApprovalOptions {
  approvals: ApprovalRegistry
  /** How long a gated call is held open. Zero refuses immediately, the old behaviour. */
  timeoutMs: number
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
 */
export function createWaitingApprovalChannel(options: WaitingApprovalOptions): ApprovalChannel {
  return {
    id: 'waiting',
    async request(requests) {
      if (options.timeoutMs <= 0) return null
      await announce(options.notify, requests)

      // Whichever route answers first wins, and the loser is told to let go of the terminal.
      const controller = new AbortController()
      try {
        return await Promise.race([
          promptOrWait(options.prompt, requests, controller.signal),
          waitForResolution(options.approvals, requests, options.timeoutMs),
        ])
      } finally {
        controller.abort()
      }
    },
  }
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
  timeoutMs: number,
): Promise<ApprovalDecision[] | null> {
  const tokens = requests.map(request => request.token)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()))
    const pending = new Set(approvals.pending().map(request => request.token))
    if (tokens.every(token => !pending.has(token))) return []
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(ms, 0)))
}
