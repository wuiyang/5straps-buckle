import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath } from '../../server/hono/dispatch.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'

// Review M1 of B13-B14: ownership is decided on the path h3 routes on, so no spelling of a moved
// route reaches the Hono copy. B15 to B17 extend the table as their prefixes move.

const nodes: BuckleHttp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const node of nodes.splice(0)) await node.close()
})

async function node(): Promise<BuckleHttp> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-http-dispatch-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const started = await createBuckleHttp({ environment: { BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'dispatch-agent-token', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' } })
  nodes.push(started)
  return started
}

describe('the canonical path', () => {
  it.each([
    ['/health', '/health'],
    ['/health/', '/health'],
    ['/%68ealth', '/health'],
    ['/health/%72eady', '/health/ready'],
    ['//health', '/health'],
    ['/health//ready/', '/health/ready'],
    ['/HEALTH', '/HEALTH'],
    ['/health%2Fready', '/health%2Fready'],
    ['/%25health', '/%25health'],
    ['/', '/'],
  ])('%s is decided as %s', (path, canonical) => {
    expect(canonicalPath(path)).toBe(canonical)
  })
})

describe('which router answers', () => {
  // B16: Hono keeps only the setup face, at node level and under /workspaces/[id]/.
  const rows: Array<{ path: string; router: 'nitro' | 'hono'; status: number; json: boolean }> = [
    { path: '/health', router: 'nitro', status: 200, json: true },
    { path: '/health/', router: 'nitro', status: 200, json: true },
    { path: '/%68ealth', router: 'nitro', status: 200, json: true },
    { path: '/health/%72eady', router: 'nitro', status: 200, json: true },
    { path: '/health?probe=1', router: 'nitro', status: 200, json: true },
    { path: '/health/ready?probe=%2F', router: 'nitro', status: 200, json: true },
    // Nitro owns the canonical path; its own router does not collapse slashes, so it answers 404.
    { path: '//health', router: 'nitro', status: 404, json: true },
    { path: '/HEALTH', router: 'nitro', status: 404, json: true },
    { path: '/health%2Fready', router: 'nitro', status: 404, json: true },
    { path: '/nope', router: 'nitro', status: 404, json: true },
    { path: '/v1/manifest', router: 'nitro', status: 401, json: true },
    { path: '/v1/%6danifest', router: 'nitro', status: 401, json: true },
    { path: '/v1//manifest', router: 'nitro', status: 401, json: true },
    { path: '/workspaces/one/%761/invoke', router: 'nitro', status: 401, json: true },
    { path: '/workspaces/one/nope', router: 'nitro', status: 401, json: true },
    { path: '/mcp', router: 'nitro', status: 401, json: true },
    { path: '/%6dcp', router: 'nitro', status: 401, json: true },
    { path: '/workspaces/one/mcp', router: 'nitro', status: 401, json: true },
    { path: '/workspaces/one/%6dcp/', router: 'nitro', status: 401, json: true },
    { path: '/workspaces/one/setup/status', router: 'hono', status: 401, json: true },
    { path: '/health/../setup', router: 'hono', status: 404, json: false },
    { path: '/health/%2e%2e/setup', router: 'hono', status: 404, json: false },
    { path: '/%73etup/status', router: 'hono', status: 404, json: false },
  ]
  for (const row of rows) {
    it(`${row.path} goes to ${row.router}`, async () => {
      const buckle = await node()
      const nitro = vi.spyOn(buckle.nitroApp, 'fetch')
      // A full URL, so `//health` stays a path and is not read as a host.
      const response = await buckle.request(`http://127.0.0.1${row.path}`)
      expect(nitro).toHaveBeenCalledTimes(row.router === 'nitro' ? 1 : 0)
      expect(response.status).toBe(row.status)
      // Nitro answers JSON everywhere; Hono's default 404 is text.
      expect(response.headers.get('content-type')).toMatch(row.json ? /^application\/json/ : /^text\/plain/)
    })
  }
})
