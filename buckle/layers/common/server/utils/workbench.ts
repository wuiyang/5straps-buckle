import { getRouterParam, HTTPError, type H3Event } from 'h3'
import { z } from 'zod'
import type { WorkbenchManager } from '../../../../common/services/workbench/manager.js'
import { withTransportAudit } from './audit.js'
import { readJson, WORKBENCH_BODY_LIMIT } from './body.js'
import { hasCode, mapAgentFailures } from './errors.js'
import { isMutation, requireWorkbench, workbenchTransportTool } from './guards.js'
import { defineOperationHandler } from './operation.js'
import { noStore } from './respond.js'
import { useTarget } from './target.js'

interface WorkbenchCall {
  event: H3Event
  workbenches: WorkbenchManager
  /** The workbench the path names, which the guard authenticated the grant for. */
  workbenchId: string
  param(name: string): string
  /** The request body read up to 1 MiB and parsed by the schema; 400 when it is not JSON or not the schema. */
  body<T>(schema: z.ZodType<T>): Promise<T>
}

/**
 * One workbench operation: the grant guard, then its transport audit when it changes anything, its
 * failures mapped as an agent may read them and its answer never cached (plan section B, route mapping).
 */
export function defineWorkbenchHandler(operation: (call: WorkbenchCall) => Promise<unknown>) {
  return defineOperationHandler({
    guards: [requireWorkbench],
    handler: async (event) => {
      const { runtime } = await useTarget(event)
      const param = (name: string) => getRouterParam(event, name, { decode: true }) ?? ''
      const call: WorkbenchCall = { event, workbenches: runtime.workbenches, workbenchId: param('workbenchId'), param, body: schema => readWorkbenchBody(event, schema) }
      const answer = () => workbenchAnswer(event, () => operation(call))
      return mapAgentFailures(() => isMutation(event) ? withTransportAudit(runtime.actions, { tool: workbenchTransportTool(event), workspaceId: runtime.workspaceId, attempt: 'required' }, answer) : answer())
    },
  })
}

/**
 * A workbench answer, for the agent routes and the owner's alike: the workbench's own refusals and
 * busy state go on to the route's error mapping (the agent allowlist, or the owner's full messages),
 * a body that fails its schema is 400, and anything else 422 with the cause in the log only.
 */
export async function workbenchAnswer(event: H3Event, run: () => Promise<unknown>): Promise<Response> {
  try {
    return noStore(await run())
  } catch (error) {
    if (HTTPError.isError(error)) throw error
    if (hasCode(error, 'WORKBENCH_REFUSED') || hasCode(error, 'STATE_BUSY')) throw error
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw invalidWorkbenchRequest()
    event.context.logger?.error('Workbench request failed', { message: error instanceof Error ? error.message : 'Unknown error', path: event.url.pathname })
    throw HTTPError.status(422, 'Unprocessable Content', { message: 'Workbench operation failed; inspect Buckle logs' })
  }
}

export async function readWorkbenchBody<T>(event: H3Event, schema: z.ZodType<T>, limit = WORKBENCH_BODY_LIMIT): Promise<T> {
  const parsed = schema.safeParse(await readJson(event, limit))
  if (!parsed.success) throw invalidWorkbenchRequest()
  return parsed.data
}

function invalidWorkbenchRequest(): HTTPError {
  return HTTPError.status(400, 'Bad Request', { message: 'Invalid workbench request' })
}
