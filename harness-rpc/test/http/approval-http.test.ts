import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliRequest } from '@5straps/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../cli/main.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'
import { captureWebhook } from '../support/webhook.js'

// The approval service reached over HTTP, as serve composes it: the harness binds the app's host,
// main's one cli:call listener and the process requester (moved from the unit tests in B15).

const TOKEN = 'approval-http-agent-token'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

async function node(extra: Record<string, string>): Promise<BuckleHttp & { workspace: string }> {
  const { workspace, environment } = nodeEnvironment('buckle-approval-http-', { BUCKLE_AUTH_TOKEN: TOKEN, BUCKLE_PACKS: 'fs', ...extra })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  return Object.assign(started, { workspace })
}

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

describe('the approval service over HTTP', () => {
  it('answers a conflicting re-send with 409, and a same re-send with the same tokens', async () => {
    const buckle = await node({})
    // A write asks for its directory, so the conflicting call writes in another one.
    mkdirSync(join(buckle.workspace, 'sub'))
    const invoke = (path: string) => buckle.request('/v1/invoke', { method: 'POST', headers,
      body: JSON.stringify({ requestId: 'rings-invocation-1', tool: 'fs_write', args: { path, content: 'x' }, context: { sessionId: 'chat-1' } }) })

    const first = await (await invoke('a.md')).json() as { outcome: string; approvals: Array<{ token: string }> }
    const again = await (await invoke('a.md')).json() as { approvals: Array<{ token: string }> }
    const conflict = await invoke('sub/b.md')

    expect(first.outcome).toBe('approval_required')
    expect(again.approvals.map(request => request.token)).toEqual(first.approvals.map(request => request.token))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ outcome: 'error', error: { code: 'APPROVAL_CONFLICT', retryable: false } })
  })

  it('asks the process requester from /v1/invoke and from an MCP tool call alike, under the agent actor', async () => {
    const buckle = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '300' })
    // An observer hears every question the app's requester dispatches to main's listener.
    const asked: CliRequest[] = []
    buckle.nitroApp.hooks!.hook('cli:call', async (request) => { asked.push(request) })

    const invoked = await buckle.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'bound-1', tool: 'fs_write', args: { path: 'a.md', content: 'x' } }) })
    expect(await invoked.json()).toMatchObject({ outcome: 'approval_required' })

    const mcp = await buckle.request('/mcp', { method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'fs_write' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_write', arguments: { path: 'b.md', content: 'y' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) })
    expect(await mcp.text()).toContain('This call needs approval')

    // Both were asked about, which an operation with no hold bound never is.
    expect(asked.map(request => request.action.details?.tool)).toEqual(['fs_write', 'fs_write'])
    // The agent guard names the caller under its credential (plan section C): the node's own token.
    expect(asked[0]!.actor).toBe('agent:node')
  })

  it('takes the approval wait hint from the invoke request\'s context', async () => {
    const buckle = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const started = performance.now()
    const response = await buckle.request('/v1/invoke', { method: 'POST', headers,
      body: JSON.stringify({ requestId: 'hinted', tool: 'fs_write', args: { path: 'a.md', content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } }) })
    expect(await response.json()).toMatchObject({ outcome: 'approval_required' })
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('lifecycle notices on the approval webhook', () => {
  it('tell answered and denied, with the recorded scope, whichever route answered', async () => {
    const webhook = await captureWebhook()
    try {
      const buckle = await node({ BUCKLE_ADMIN_TOKEN: 'approval-http-admin-token', BUCKLE_APPROVAL_WEBHOOK: webhook.url })
      mkdirSync(join(buckle.workspace, 'one'))
      mkdirSync(join(buckle.workspace, 'two'))
      const [first, second] = await Promise.all(['one/a.md', 'two/b.md'].map(async (path) => {
        const response = await buckle.runtime.invoke({ sessionId: 's', request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
        if (response.outcome !== 'approval_required') throw new Error(`expected an approval, got ${response.outcome}`)
        return response.approvals[0]!.token
      }))

      // `buckle approve` is another process's view of the same state; the setup face is this one's.
      expect((await runCli({ argv: ['approve', first!, '--scope', 'session'], config: buckle.config })).exitCode).toBe(0)
      expect((await buckle.request('/setup/approvals', { method: 'POST', headers: { authorization: 'Bearer approval-http-admin-token', 'content-type': 'application/json' }, body: JSON.stringify({ token: second, approved: false, scope: 'once' }) })).status).toBe(200)
      await buckle.runtime.approvalService.close()

      expect(webhook.notices).toEqual(expect.arrayContaining([
        expect.objectContaining({ token: first, event: 'skipped', reason: 'caller_declined_wait' }),
        expect.objectContaining({ token: first, event: 'answered', scope: 'session' }),
        expect.objectContaining({ token: second, event: 'denied', scope: 'once' }),
      ]))
      expect(webhook.bodies[0]).toMatchObject({ serverId: buckle.config.serverId, workspaceId: 'default' })
    } finally {
      await webhook.close()
    }
  })
})
