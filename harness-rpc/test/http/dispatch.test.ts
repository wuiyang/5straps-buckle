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
  const rows: Array<{ path: string; router: 'nitro' | 'hono'; status: number }> = [
    { path: '/health', router: 'nitro', status: 200 },
    { path: '/health/', router: 'nitro', status: 200 },
    { path: '/%68ealth', router: 'nitro', status: 200 },
    { path: '/health/%72eady', router: 'nitro', status: 200 },
    { path: '/health?probe=1', router: 'nitro', status: 200 },
    { path: '/health/ready?probe=%2F', router: 'nitro', status: 200 },
    // Nitro owns the canonical path; its own router does not collapse slashes, so it answers 404.
    { path: '//health', router: 'nitro', status: 404 },
    { path: '/health/../setup', router: 'hono', status: 404 },
    { path: '/health/%2e%2e/setup', router: 'hono', status: 404 },
    { path: '/HEALTH', router: 'hono', status: 404 },
    { path: '/health%2Fready', router: 'hono', status: 404 },
  ]
  for (const row of rows) {
    it(`${row.path} goes to ${row.router}`, async () => {
      const buckle = await node()
      const nitro = vi.spyOn(buckle.nitroApp, 'fetch')
      // A full URL, so `//health` stays a path and is not read as a host.
      const response = await buckle.request(`http://127.0.0.1${row.path}`)
      expect(nitro).toHaveBeenCalledTimes(row.router === 'nitro' ? 1 : 0)
      expect(response.status).toBe(row.status)
      // Each router's own shape: Nitro answers JSON everywhere, Hono's default 404 is text.
      expect(response.headers.get('content-type')).toMatch(row.router === 'nitro' ? /^application\/json/ : /^text\/plain/)
    })
  }
})
