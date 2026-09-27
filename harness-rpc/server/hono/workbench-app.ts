import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  WorkbenchActorInputSchema, WorkbenchApplySchema, WorkbenchControlSchema, WorkbenchInvokeSchema,
  WorkbenchProvisionSchema, WorkbenchTerminalInputSchema, WorkbenchTerminalResizeSchema, WorkbenchTerminalStartSchema,
} from '@5straps/protocol'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { auditHttpRequest } from './audit.js'
import { logger } from '../../common/runtime/log.js'
import { WorkbenchError } from '../../common/services/workbench/storage.js'

export function createWorkbenchApp(runtime: BuckleRuntime): Hono {
  const app = new Hono()
  const audit = auditHttpRequest({ actions: runtime.actions, workspaceId: runtime.workspaceId, face: 'http_workbench' })
  app.use('*', async (context, next) => { if (!['GET', 'HEAD'].includes(context.req.method)) return audit(context, next); await next() })
  app.use('*', bodyLimit({ maxSize: 1_048_576 }))
  app.use('/:id', authorize)
  app.use('/:id/*', authorize)
  async function authorize(context: Context, next: () => Promise<void>) {
    if (!runtime.workbenches.authenticate(context.req.param('id') ?? '', context.req.header('authorization'))) {
      await runtime.workbenches.auditRejected()
      return context.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
  app.get('/:id', context => respond(context, { workbench: runtime.workbenches.get(context.req.param('id')) }))
  app.post('/:id/invoke', async context => respond(context, await runtime.workbenches.invoke(context.req.param('id'), WorkbenchInvokeSchema.parse(await context.req.json()))))
  app.post('/:id/terminals', async context => respond(context, await runtime.workbenches.startTerminal(context.req.param('id'), WorkbenchTerminalStartSchema.parse(await context.req.json()))))
  app.get('/:id/terminals/:terminalId/events', context => respond(context, runtime.workbenches.terminalEvents(context.req.param('id'), context.req.param('terminalId'), Number(context.req.query('after') ?? '0'))))
  app.post('/:id/terminals/:terminalId/control', async context => respond(context, await runtime.workbenches.controlTerminal(context.req.param('id'), context.req.param('terminalId'), WorkbenchControlSchema.parse(await context.req.json()))))
  app.post('/:id/terminals/:terminalId/input', async context => respond(context, await runtime.workbenches.terminalInput(context.req.param('id'), context.req.param('terminalId'), WorkbenchTerminalInputSchema.parse(await context.req.json()))))
  app.patch('/:id/terminals/:terminalId', async context => respond(context, await runtime.workbenches.resizeTerminal(context.req.param('id'), context.req.param('terminalId'), WorkbenchTerminalResizeSchema.parse(await context.req.json()))))
  app.post('/:id/terminals/:terminalId/stop', async context => {
    const { actorId } = WorkbenchActorInputSchema.parse(await context.req.json())
    return respond(context, await runtime.workbenches.stopTerminal(context.req.param('id'), context.req.param('terminalId'), actorId))
  })
  app.post('/:id/reviews', async context => {
    const { actorId } = WorkbenchActorInputSchema.parse(await context.req.json())
    return respond(context, await runtime.workbenches.review(context.req.param('id'), actorId))
  })
  app.post('/:id/apply', async context => respond(context, await runtime.workbenches.apply(context.req.param('id'), WorkbenchApplySchema.parse(await context.req.json()))))
  app.post('/:id/discard', async context => {
    const { actorId } = WorkbenchActorInputSchema.parse(await context.req.json())
    return respond(context, await runtime.workbenches.discard(context.req.param('id'), actorId))
  })
  app.onError(handleWorkbenchError)
  return app
}

export function createWorkbenchSetupApp(runtime: BuckleRuntime): Hono {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 65_536 }))
  app.get('/', context => respond(context, { workbenches: runtime.workbenches.list() }))
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
  if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: 'Invalid workbench request' }, 400)
  logger.error('Workbench request failed', { message: error.message, path: context.req.path })
  return context.json({ error: 'Workbench operation failed; inspect Buckle logs' }, 422)
}
