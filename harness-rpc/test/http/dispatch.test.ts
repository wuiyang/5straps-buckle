import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Review M1 of B13-B14 asked that no spelling of a moved route reach the other router's copy. Since
// B17 every face is on the Nitro layers, so every spelling reaches Nitro, which routes on h3's
// canonical path: needless escapes decoded, one trailing slash ignored, case and slashes kept.

const nodes: BuckleHttp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const node of nodes.splice(0)) await node.close()
})

async function node(): Promise<BuckleHttp> {
  const started = await createBuckleHttp({ environment: nodeEnvironment('buckle-http-dispatch-', { BUCKLE_AUTH_TOKEN: 'dispatch-agent-token', BUCKLE_ADMIN_TOKEN: 'dispatch-admin-token', BUCKLE_PACKS: 'fs' }).environment })
  nodes.push(started)
  return started
}

describe('every spelling of a path is answered by the Nitro layers', () => {
  const rows: Array<{ path: string; status: number }> = [
    { path: '/health', status: 200 },
    { path: '/health/', status: 200 },
    { path: '/%68ealth', status: 200 },
    { path: '/health/%72eady', status: 200 },
    { path: '/health?probe=1', status: 200 },
    { path: '/health/ready?probe=%2F', status: 200 },
    { path: '//health', status: 404 },
    { path: '/HEALTH', status: 404 },
    { path: '/health%2Fready', status: 404 },
    { path: '/nope', status: 404 },
    { path: '/v1/manifest', status: 401 },
    { path: '/v1/%6danifest', status: 401 },
    { path: '/v1//manifest', status: 401 },
    { path: '/workspaces/one/%761/invoke', status: 401 },
    { path: '/workspaces/one/nope', status: 401 },
    { path: '/mcp', status: 401 },
    { path: '/%6dcp', status: 401 },
    { path: '/workspaces/one/%6dcp/', status: 401 },
    { path: '/setup/status', status: 401 },
    { path: '/%73etup/status', status: 401 },
    { path: '/health/../setup/status', status: 401 },
    { path: '/health/%2e%2e/setup/status', status: 401 },
    { path: '/workspaces/one/setup/status', status: 401 },
    { path: '/setup/../../setup/workspaces', status: 401 },
  ]
  for (const row of rows) {
    it(`${row.path} answers ${row.status}`, async () => {
      const buckle = await node()
      const nitro = vi.spyOn(buckle.nitroApp, 'fetch')
      // A full URL, so `//health` stays a path and is not read as a host.
      const response = await buckle.request(`http://127.0.0.1${row.path}`)
      expect(nitro).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(row.status)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
    })
  }
})
