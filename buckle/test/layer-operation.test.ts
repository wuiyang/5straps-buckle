import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useScope } from '@5straps/runtime'
import { H3 } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import { defineOperationHandler } from '../layers/common/server/utils/operation.js'

const commons: BuckleCommon[] = []
afterEach(async () => { for (const common of commons.splice(0)) await common.owner.close() })

async function started(): Promise<BuckleCommon> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-layer-operation-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const common = initializeCommon({ config: loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }), role: 'server' })
  commons.push(common)
  await common.start()
  return common
}

/** An H3 app whose requests carry the context the Buckle context plugin attaches from main's host. */
function app(common: BuckleCommon | null): H3 {
  const h3 = new H3()
  if (common) h3.use((event) => { event.context.runtime = common.owner; event.context.services = { ...common.services, getMcpHandlers: () => { throw new Error('No MCP face in this app') } } })
  return h3
}

describe('a Buckle operation handler on the Nitro layer', () => {
  it('opens its own operation scope with the HTTP hold bound, so a gated call waits the grace period', async () => {
    const common = await started()
    const h3 = app(common)
    h3.get('/probe', defineOperationHandler({ guards: [], handler: async (_event, scope) => ({ same: useScope() === scope, hold: (await common.services.getInteraction(scope)).current() }) }))

    const first = await h3.fetch(new Request('http://127.0.0.1/probe'))
    const second = await h3.fetch(new Request('http://127.0.0.1/probe'))

    expect(await first.json()).toEqual({ same: true, hold: 'grace' })
    // A fresh scope per request: binding twice in one scope would throw.
    expect(second.status).toBe(200)
  })

  it('refuses before any handler runs when main bound nothing, or the runtime is not ready', async () => {
    let ran = false
    const unbound = app(null)
    unbound.get('/probe', defineOperationHandler({ guards: [], handler: () => { ran = true; return {} } }))
    expect((await unbound.fetch(new Request('http://127.0.0.1/probe'))).status).toBe(503)

    const common = await started()
    await common.owner.close()
    const closed = app(common)
    closed.get('/probe', defineOperationHandler({ guards: [], handler: () => { ran = true; return {} } }))
    expect((await closed.fetch(new Request('http://127.0.0.1/probe'))).status).toBe(503)
    expect(ran).toBe(false)
  })
})

describe('the HEAD plugin (review L12 of B18-B19)', () => {
  it('refuses to start without the h3 app or its ~findRoute, instead of leaving HEAD unserved', async () => {
    const { default: headPlugin } = await import('../layers/common/server/plugins/20.head.js')
    const start = (nitroApp: unknown) => () => headPlugin(nitroApp as Parameters<typeof headPlugin>[0])
    expect(start({})).toThrow('~findRoute')
    expect(start({ h3: {} })).toThrow('~findRoute')
    const app = new H3()
    expect(start({ h3: app })).not.toThrow()
  })
})
