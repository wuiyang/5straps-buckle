import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as runtime from '@5straps/runtime'
import { NitroErrorCode, registerCliListener, useHost } from '@5straps/runtime/nitro'
import { afterEach, describe, expect, inject, it, vi } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'

const build = inject('buckleBuild')
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

function environment(extra: Record<string, string> = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-http-build-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return { BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'build-agent-token', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', ...extra }
}

async function node(input: { headless?: boolean; environment?: Record<string, string> } = {}): Promise<BuckleHttp> {
  const started = await createBuckleHttp({ environment: input.environment ?? environment(), ...(input.headless ? { headless: true } : {}) })
  nodes.push(started)
  return started
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(path => join(directory, path)).filter(path => statSync(path).isFile())
}

// Strings that exist only in Buckle's common code or inside @5straps/runtime: finding one in .output
// would mean a second copy was bundled instead of imported (Buckle phase plan, section B).
const BUNDLED_ELSEWHERE = [
  'This process already has its requester bound',
  'Approval was declined',
  'Workspace is disabled or retired',
  'A cli:call listener is already registered',
  'No operation scope is active',
]

describe('the built server (.output)', () => {
  it('has the custom entry and no native addon, with and without the admin layer', () => {
    for (const output of Object.values(build.outputs)) {
      expect(statSync(join(output, 'server', 'index.mjs')).isFile()).toBe(true)
      expect(files(output).filter(path => path.endsWith('.node'))).toEqual([])
    }
  })

  it('checks for markers that do exist: each is in the built common code or the runtime it imports (review L3 of B13-B14)', () => {
    const runtimeDist = dirname(createRequire(build.entries.full).resolve('@5straps/runtime'))
    const elsewhere = [...files(join(build.root, 'dist', 'common')), ...files(runtimeDist)].filter(path => path.endsWith('.js')).map(path => readFileSync(path, 'utf8'))
    expect(BUNDLED_ELSEWHERE.filter(marker => !elsewhere.some(text => text.includes(marker)))).toEqual([])
  })

  it('bundles neither common nor the runtime: route chunks import @5straps/runtime bare', () => {
    const built = files(build.outputs.full).filter(path => path.endsWith('.mjs'))
    for (const path of built) {
      const text = readFileSync(path, 'utf8')
      expect(BUNDLED_ELSEWHERE.filter(marker => text.includes(marker)), relative(build.root, path)).toEqual([])
    }
    expect(readFileSync(join(build.outputs.full, 'server', '_routes', 'health', 'ready.mjs'), 'utf8')).toMatch(/from "@5straps\/runtime\/nitro"/)
    expect(readFileSync(join(build.outputs.full, 'server', 'index.mjs'), 'utf8')).toMatch(/from "@5straps\/runtime"/)
  })

  it('shares one @5straps/runtime with main: the app resolves the module this process runs', async () => {
    const resolved = createRequire(build.entries.full).resolve('@5straps/runtime')
    expect(await import(pathToFileURL(resolved).href)).toBe(runtime)
  })

  it('takes exactly one cli:call listener: main\'s, and a second is refused until it is released', async () => {
    const buckle = await node()
    const second = () => registerCliListener(buckle.nitroApp, async () => {})
    expect(second).toThrow(expect.objectContaining({ code: NitroErrorCode.cliListenerRegistered }))
    await buckle.close()
    second()()
  })

  it('gives the app\'s host the process requester, with the pending-approval fallback (review L7 of B13-B14)', async () => {
    const buckle = await node()
    expect(useHost(buckle.nitroApp)?.requestCli).toBe(buckle.requestCli)
    const question = { id: 'approval:default:t1', kind: 'approval', correlationId: 'c1', target: 'default', action: { summary: 'probe', details: { approve: 'buckle approve t1' } }, wait: { mode: 'finite', timeoutMs: 1_000 } } as const
    await buckle.close()
    // With the listener gone, the host's requester reports the ask as pending, never a bare unavailable.
    expect(await buckle.requestCli(question)).toMatchObject({ status: 'unavailable', pending: { id: 'approval:default:t1', instructions: 'buckle approve t1' } })
  })

  it('reports ready once started, shutting down while it closes, and not ready again once closed', async () => {
    const buckle = await node()
    expect((await buckle.request('/health/ready')).status).toBe(200)
    const held = Promise.withResolvers<void>()
    buckle.common.owner.onClose('waiters', 'held by the test', () => held.promise)
    const closing = buckle.close()
    const shuttingDown = await buckle.request('/health/ready')
    expect(shuttingDown.status).toBe(503)
    expect(await shuttingDown.json()).toEqual({ error: 'Runtime is shutting down' })
    held.resolve()
    await closing
    const closed = await buckle.nitroApp.fetch(new Request('http://127.0.0.1/health/ready'))
    expect(closed.status).toBe(503)
    expect(await closed.json()).toEqual({ error: 'Runtime is not attached to this request' })
  })

  it('leaves the admin layer out of the build config under --no-admin', async () => {
    const config = async (admin: string) => {
      vi.stubEnv('BUCKLE_BUILD_ADMIN_LAYER', admin)
      vi.resetModules()
      try { return (await import('../../nitro.config.js')).default } finally { vi.unstubAllEnvs() }
    }
    expect((await config('false')).extends).toEqual(['./layers/common', './layers/mcp'])
    expect((await config('true')).extends).toEqual(['./layers/common', './layers/mcp', './layers/admin'])
  })

  it('serves no /setup route from the build without the admin layer, even with an admin credential', async () => {
    const buckle = await node({ headless: true, environment: environment({ BUCKLE_ADMIN_TOKEN: 'build-admin-token' }) })
    const setup = await buckle.nitroApp.fetch(new Request('http://127.0.0.1/setup/status', { headers: { authorization: 'Bearer build-admin-token' } }))
    expect(setup.status).toBe(404)
    expect(await setup.json()).toEqual({ error: 'Not Found' })
    expect((await buckle.request('/health')).status).toBe(200)
  })
})
