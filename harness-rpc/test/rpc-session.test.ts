import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../common/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../common/runtime/config.js'
import { createHttpApp } from '../server/hono/http-app.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

const TOKEN = 'test-token'

let app: Hono
let runtime: BuckleRuntime

beforeEach(async () => {
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: TOKEN,
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-rpc-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
  runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  app = createHttpApp({ config, runtime, authToken: TOKEN })
})

async function invoke(requestId: string, sessionId?: string) {
  const response = await app.request('/v1/invoke', {
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
    expect((await runtime.approvals.resolve({ token, approved: true, scope: 'session' }, 'admin')).ok).toBe(true)

    expect((await invoke('two')).outcome).toBe('ok')
    expect((await invoke('three')).outcome).toBe('ok')
  })

  it('does not leak into a caller that named a different session', async () => {
    const first = await invoke('one')
    const token = first.approvals?.[0]?.token
    if (!token) throw new Error('expected an approval token')
    await runtime.approvals.resolve({ token, approved: true, scope: 'session' }, 'admin')

    expect((await invoke('two', 'someone-else')).outcome).toBe('approval_required')
  })

  it('still refuses a caller that was never approved at all', async () => {
    expect((await invoke('one', 'stranger')).outcome).toBe('approval_required')
  })

  it('names the readable roots in the refusal, since an MCP caller cannot read the manifest', async () => {
    const first = await invoke('one')
    expect(first.outcome).toBe('approval_required')
    const response = await app.request('/v1/manifest', { headers: { authorization: `Bearer ${TOKEN}` } })
    const manifest = await response.json() as { workspaceRoots: string[] }
    expect(JSON.stringify(first)).toContain(manifest.workspaceRoots[0])
  })
})
