import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { WorkbenchProvisionSchema } from '@5straps/protocol'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { logger } from '../../common/runtime/log.js'
import { WorkbenchError } from '../../common/services/workbench/storage.js'
import { stateBusyResponse } from './state-busy.js'

export function createWorkbenchSetupApp(runtime: BuckleRuntime): Hono {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 65_536 }))
  app.get('/', async context => respond(context, { workbenches: await runtime.workbenches.list() }))
  app.post('/:id/recover', async context => respond(context, await runtime.workbenches.recover(context.req.param('id'))))
  app.post('/', async context => respond(context, { workbench: await runtime.workbenches.provision(WorkbenchProvisionSchema.parse(await context.req.json())) }))
  app.onError(handleWorkbenchError)
  return app
}

function respond(context: Context, value: unknown): Response {
  return context.body(JSON.stringify(value), 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
}
function handleWorkbenchError(error: Error, context: Context): Response {
  if (error instanceof WorkbenchError) return context.json({ error: error.message }, error.status)
  const busy = stateBusyResponse(error, context)
  if (busy) return busy
  if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: 'Invalid workbench request' }, 400)
  logger.error('Workbench request failed', { message: error.message, path: context.req.path })
  return context.json({ error: 'Workbench operation failed; inspect Buckle logs' }, 422)
}
