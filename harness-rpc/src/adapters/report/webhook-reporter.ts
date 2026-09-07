import type { DeniedRunReport } from '@5straps/protocol'
import type { Reporter } from '../../ports/reporter.js'
import { logger } from '../../logger.js'

const REPORT_TIMEOUT_MS = 5_000

/**
 * Posts each refused call to the owner's endpoint, Rings as a rule, carrying its own bearer
 * token. Like the approval webhook, the URL is operator configuration rather than model input,
 * so it is not held to the egress rules that judge a tool's own network access.
 */
export function createWebhookReporter(input: { url: string; token: string }): Reporter {
  return {
    configured: true,
    async report(report: DeniedRunReport) {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.token}` },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (!response.ok) logger.warn('The report endpoint refused a denied-run report', { status: response.status })
    },
  }
}
