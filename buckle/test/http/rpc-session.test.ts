import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

const TOKEN = 'test-token'

let buckle: BuckleHttp

beforeEach(async () => {
  buckle = await createBuckleHttp({ environment: nodeEnvironment('buckle-rpc-', { BUCKLE_AUTH_TOKEN: TOKEN }).environment })
})
afterEach(() => buckle.close())

async function invoke(requestId: string, sessionId?: string) {
  const response = await buckle.request('/v1/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      requestId,
      tool: 'fs_read',
      args: { path: '/etc/hostname' },
      ...(sessionId ? { context: { sessionId } } : {}),
    }),
  })
  return await response.json() as { outcome: string; approvals?: Array<{ token: string }> }
}

describe('an approval granted while the server keeps running', () => {
  it('applies to the next call, which is the whole approval flow working', async () => {
    const first = await invoke('one')
    expect(first.outcome).toBe('approval_required')

    const token = first.approvals?.[0]?.token
    expect(token).toBeDefined()
    if (!token) return

    // Stands in for `buckle approve` in a terminal: resolve, then call the server again.
    expect((await buckle.runtime.approvals.resolve({ token, approved: true, scope: 'session' }, 'admin')).ok).toBe(true)

    expect((await invoke('two')).outcome).toBe('ok')
    expect((await invoke('three')).outcome).toBe('ok')
  })

  it('does not leak into a caller that named a different session', async () => {
    const first = await invoke('one')
    const token = first.approvals?.[0]?.token
    if (!token) throw new Error('expected an approval token')
    await buckle.runtime.approvals.resolve({ token, approved: true, scope: 'session' }, 'admin')

    expect((await invoke('two', 'someone-else')).outcome).toBe('approval_required')
  })

  it('still refuses a caller that was never approved at all', async () => {
    expect((await invoke('one', 'stranger')).outcome).toBe('approval_required')
  })

  it('names the readable roots in the refusal, since an MCP caller cannot read the manifest', async () => {
    const first = await invoke('one')
    expect(first.outcome).toBe('approval_required')
    const response = await buckle.request('/v1/manifest', { headers: { authorization: `Bearer ${TOKEN}` } })
    const manifest = await response.json() as { workspaceRoots: string[] }
    expect(JSON.stringify(first)).toContain(manifest.workspaceRoots[0])
  })
})
