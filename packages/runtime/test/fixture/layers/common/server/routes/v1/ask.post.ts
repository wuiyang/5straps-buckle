import { HTTPError, type H3Event } from 'h3'
import { useNitroApp } from 'nitro/app'
import { InteractionErrorCode, isRuntimeError, type RequestCli } from '@5straps/runtime'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { askOwner } from '../../../../../common/interaction.js'
import { requireAgent, useServices } from '../../utils/guards.js'

const MAX_SUMMARY = 200
const MAX_TIMEOUT_MS = 600_000
const INTERACTION_FAILURES: readonly string[] = [InteractionErrorCode.listenerFailed, InteractionErrorCode.noCompletion]

// HTTP to CLI: event.context.requestCli emits cli:call; main's listener forwards to the terminal (F07).
export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event, scope) => {
    const input = await readAsk(event.req)
    const services = useServices(event)
    ;(await services.getOperation()).record('ask')
    try {
      const outcome = await askOwner({ ...input, requestCli: withdrawOnAbort(event), approvals: await services.getApprovals(), signal: event.req.signal })
      return { outcome, correlationId: scope.context.correlationId }
    } catch (error) {
      // F09: a failed or silent listener is a typed server error, never a hung request.
      if (isRuntimeError(error) && INTERACTION_FAILURES.includes(error.code)) throw HTTPError.status(500, 'Internal Server Error', { message: `CLI interaction failed: ${error.code}` })
      throw error
    }
  },
})

function withdrawOnAbort(event: H3Event): RequestCli {
  const requestCli = event.context.requestCli
  if (!requestCli) throw HTTPError.status(503, 'Service Unavailable', { message: 'CLI interaction is not attached' })
  return (request, options) => {
    event.req.signal.addEventListener('abort', () => { void useNitroApp().hooks?.callHook('cli:cancel', request.id) }, { once: true })
    return requestCli(request, options)
  }
}

async function readAsk(request: Request): Promise<{ summary: string; timeoutMs?: number }> {
  const body = await request.json().catch(() => undefined) as { summary?: unknown; timeoutMs?: unknown } | undefined
  const summary = body?.summary
  const timeoutMs = body?.timeoutMs
  if (typeof summary !== 'string' || summary.length === 0 || summary.length > MAX_SUMMARY) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid summary' })
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > MAX_TIMEOUT_MS)) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid timeoutMs' })
  return { summary, ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) }
}
