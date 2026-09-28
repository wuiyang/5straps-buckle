import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'

const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

function environment(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-http-health-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return { BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'health-agent-token', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }
}

describe('health on the Nitro layer', () => {
  it('leaves /health open and answers /health/ready through the dispatcher, as serve does', async () => {
    const node = await createBuckleHttp({ environment: environment() })
    nodes.push(node)
    const health = await node.request('/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok', serverId: node.config.serverId, protocolVersion: expect.any(String) })
    expect(await (await node.request('/health/ready')).json()).toEqual({ status: 'ready' })
  })
})
