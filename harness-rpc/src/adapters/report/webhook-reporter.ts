import { ACTION_REPORT_BATCH_MAX, type ActionReport, type DeniedRunReport } from '@5straps/protocol'
import { SEALED_REPORT_PATHS, type ApprovalKey } from '@5straps/protocol/envelope'
import { sealForRings } from '../../services/approval-envelope.js'
import type { Reporter } from '../../ports/reporter.js'
import { logger } from '../../logger.js'

const REPORT_TIMEOUT_MS = 5_000
/** How long a partial batch waits for company before it goes out on its own. */
const FLUSH_INTERVAL_MS = 5_000
/** Entries held while the endpoint is unreachable; past this the oldest are dropped. */
const QUEUE_LIMIT = 500
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1_000

export interface WebhookReporterOptions {
  url: string
  token: string
  serverId: string
  /** `RINGS-D20`: with the key minted at pairing, every report goes sealed. */
  approvalKey?: ApprovalKey
  flushIntervalMs?: number
  retryDelayMs?: number
}

/**
 * Posts this node's calls to the owner's endpoint, Rings as a rule, carrying its own bearer
 * token. Like the approval webhook, the URL is operator configuration rather than model input,
 * so it is not held to the egress rules that judge a tool's own network access.
 *
 * The action log is batched and the node's own `actions.jsonl` is written first, so a batch
 * that cannot be delivered is dropped from memory without losing the record.
 */
export function createWebhookReporter(options: WebhookReporterOptions): Reporter {
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  const queue: ActionReport[] = []
  let dropped = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let draining: Promise<void> = Promise.resolve()

  const post = async (body: unknown): Promise<'sent' | 'refused' | 'unreachable'> => {
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
        // Sealed per attempt, so a retry carries a fresh nonce rather than looking like a replay.
        body: JSON.stringify(sealForRings(options.approvalKey, SEALED_REPORT_PATHS.reports, body)),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (response.ok) return 'sent'
      logger.warn('The report endpoint refused a Buckle report', { status: response.status })
      // A refusal of the payload itself repeats on every attempt; only a server fault is worth retrying.
      return response.status < 500 ? 'refused' : 'unreachable'
    } catch (error: unknown) {
      logger.warn('Could not reach the report endpoint', { message: error instanceof Error ? error.message : 'Unknown error' })
      return 'unreachable'
    }
  }

  const postBatch = async (reports: ActionReport[]): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (await post({ event: 'action_log', serverId: options.serverId, reports }) !== 'unreachable') return
      if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs * attempt)
    }
    logger.warn('Gave up on a batch of action-log entries; the node keeps them in its own log', { entries: reports.length })
  }

  const drain = async (): Promise<void> => {
    if (dropped > 0) {
      logger.warn('The action-log report queue overflowed; the oldest entries were dropped', { dropped, limit: QUEUE_LIMIT })
      dropped = 0
    }
    while (queue.length > 0) await postBatch(queue.splice(0, ACTION_REPORT_BATCH_MAX))
  }

  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    draining = draining.then(drain, drain)
    return draining
  }

  return {
    configured: true,

    async report(report: DeniedRunReport) {
      await post(report)
    },

    record(entry: ActionReport) {
      if (queue.length >= QUEUE_LIMIT) {
        queue.shift()
        dropped++
      }
      queue.push(entry)
      if (queue.length >= ACTION_REPORT_BATCH_MAX) { void flush(); return }
      if (timer) return
      timer = setTimeout(() => { void flush() }, flushIntervalMs)
      timer.unref?.()
    },

    flush,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
