import { createRuntimeOwner, useScope, type OperationScope } from '@5straps/runtime'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { BuckleCommon } from '../common/runtime/initialize.js'
import type { BuckleServices } from '../common/runtime/services.js'
import { operationScopes, type ScopeEnv } from '../server/hono/operation-scope.js'

function probeApp() {
  const owner = createRuntimeOwner({ services: [] })
  const services: BuckleServices = { getWorkspaceRuntime: () => Promise.reject(new Error('not needed here')) }
  const common: BuckleCommon = { role: 'server', owner, services, start: () => owner.start(() => {}) }
  const seen: Array<{ scope: OperationScope; ambient: OperationScope; services: BuckleServices }> = []
  const app = new Hono<ScopeEnv>()
  app.use('*', operationScopes(common))
  app.get('/probe', (context) => {
    seen.push({ scope: context.get('scope'), ambient: useScope(), services: context.get('services') })
    return context.json({ ok: true })
  })
  return { app, common, services, seen }
}

describe('the temporary Hono operation-scope middleware', () => {
  it('answers 503 before the common runtime is ready and after it starts closing', async () => {
    const { app, common, seen } = probeApp()
    const starting = await app.request('/probe')
    expect(starting.status).toBe(503)
    expect(await starting.json()).toEqual({ error: 'Buckle is not ready' })

    await common.start()
    expect((await app.request('/probe')).status).toBe(200)
    await common.owner.close()
    expect((await app.request('/probe')).status).toBe(503)
    expect(seen).toHaveLength(1)
  })

  it('runs each request in its own scope, with the accessors on the context, and disposes it after the response', async () => {
    const { app, common, services, seen } = probeApp()
    await common.start()
    await app.request('/probe', { headers: { 'x-request-id': 'client-7' } })
    await app.request('/probe')

    const [first, second] = seen
    expect(first!.ambient).toBe(first!.scope)
    expect(first!.services).toBe(services)
    expect(first!.scope.context.clientRequestId).toBe('client-7')
    expect(second!.scope.context.clientRequestId).toBeUndefined()
    expect(second!.scope.context.correlationId).not.toBe(first!.scope.context.correlationId)
    expect(first!.scope.owner).toBe(common.owner.registry.owner)
    await expect.poll(() => [first!.scope.state, second!.scope.state]).toEqual(['disposed', 'disposed'])
    await common.owner.close()
  })
})
