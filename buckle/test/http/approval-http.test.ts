import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliRequest } from '@5straps/runtime'
import { generateSigningKey, publicKeyFrom, readChallenge, signingKeyFromPem, signRequest } from '@5straps/protocol/signed-request'
import { keysCommand } from '../../cli/keys.js'
import { requestIdKey } from '../../common/services/invocation/executions.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../support/cli.js'
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
  // Review H3 of B23-B25: a re-send with other arguments is another call under a reused requestId.
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
    expect(await conflict.json()).toMatchObject({ outcome: 'error', error: { code: 'REQUEST_ID_REUSED', retryable: false } })
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
      const buckle = await node({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'approval-http-admin-token', BUCKLE_APPROVAL_WEBHOOK: webhook.url })
      mkdirSync(join(buckle.workspace, 'one'))
      mkdirSync(join(buckle.workspace, 'two'))
      const [first, second] = await Promise.all(['one/a.md', 'two/b.md'].map(async (path) => {
        const response = await buckle.runtime.invoke({ sessionId: 's', request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
        if (response.outcome !== 'approval_required') throw new Error(`expected an approval, got ${response.outcome}`)
        return response.approvals[0]!.token
      }))

      // `buckle approve` is another process's view of the same state, confirmed at its terminal (owner decision D17); the setup face is this one's.
      expect((await runCli({ argv: ['approve', first!, '--scope', 'session'], config: buckle.config, confirm: async () => true })).exitCode).toBe(0)
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

describe('a withdraw of a call already answered (review L1 of B23-B25)', () => {
  it('drops its answered once, so no other call writes where it was approved', async () => {
    const buckle = await node({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'approval-http-admin-token' })
    const admin = { authorization: 'Bearer approval-http-admin-token', 'content-type': 'application/json' }
    const asked = await (await buckle.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'answered-1', tool: 'fs_write', args: { path: 'answered.md', content: 'x' }, context: { sessionId: 'rings-chat', approvalWait: { mode: 'none' } } }) })).json() as { approvals: Array<{ token: string }> }
    const token = asked.approvals[0]!.token
    expect((await buckle.request('/setup/approvals', { method: 'POST', headers: admin, body: JSON.stringify({ token, approved: true, scope: 'once' }) })).status).toBe(409)
    expect(buckle.runtime.approvals.unspent('rings-chat')).toEqual([])
    const owner = generateSigningKey()
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try { expect((await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['enroll', owner.publicKey, '--purpose', 'approval', '--workspace', 'default'] })).exitCode).toBe(0) }
    finally { output.mockRestore() }
    const identity = await buckle.services.getNodeSigner()
    const authorization = (method: string, path: string, body: string) => signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: buckle.config.serverId, nodeKey: identity.keyId, workspace: 'default', method, path, body })
    const path = '/setup/approvals/challenges'
    const listed = await buckle.request(path, { headers: { authorization: authorization('GET', path, '') } })
    expect(listed.status).toBe(200)
    const item = ((await listed.json()) as { challenges: Array<{ token: string; signed: string; digest: string }> }).challenges.find(item => item.token === token)!
    const verified = readChallenge({ signed: item.signed, nodeKey: publicKeyFrom(identity.publicKey) })!
    expect(verified.digest).toBe(item.digest)
    expect(verified.challenge).toMatchObject({ token, tool: 'fs_write', arguments: { path: 'answered.md', content: 'x' }, cwd: buckle.config.cwd })
    const body = JSON.stringify({ token, approved: true, scope: 'once', challenge: verified.digest })
    expect((await buckle.request('/setup/approvals', { method: 'POST', headers: { ...admin, authorization: authorization('POST', '/setup/approvals', body) }, body })).status).toBe(200)
    expect(buckle.runtime.approvals.unspent('rings-chat')).toHaveLength(1)
    // Rings cancels the run: the token form finds the answered group and drops its once.
    const withdrawn = await (await buckle.request('/setup/approvals/withdraw', { method: 'POST', headers: admin, body: JSON.stringify({ token }) })).json()
    expect(withdrawn).toEqual({ withdrawn: [], dropped: [token] })
    expect(buckle.runtime.approvals.unspent('rings-chat')).toEqual([])
    const other = await (await buckle.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'answered-2', tool: 'fs_write', args: { path: 'other.md', content: 'y' }, context: { sessionId: 'rings-chat', approvalWait: { mode: 'none' } } }) })).json() as { outcome: string }
    expect(other.outcome).toBe('approval_required')
  })
})

describe('the admin approvals listing (review M1)', () => {
  it('lists each waiting request with the whole call it came from', async () => {
    const buckle = await node({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'approval-http-admin-token' })
    const admin = { authorization: 'Bearer approval-http-admin-token' }
    const asked = await (await buckle.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'listed-1', tool: 'fs_write', args: { path: 'listed.md', content: 'listed content' }, context: { sessionId: 'rings-chat', approvalWait: { mode: 'none' } } }) })).json() as { approvals: Array<{ token: string }> }
    const listed = await (await buckle.request('/setup/approvals', { headers: admin })).json() as { approvals: Array<Record<string, unknown>> }
    expect(listed.approvals).toEqual([expect.objectContaining({
      token: asked.approvals[0]!.token, tool: 'fs_write',
      call: { arguments: { content: 'listed content', path: 'listed.md' }, cwd: buckle.config.cwd, description: expect.stringContaining('listed.md'), effects: [`write ${join(buckle.config.cwd, 'listed.md')}`] },
    })])
  })
})

describe('the setup face withdraws one call\'s asks (owner decision D6, review M1 of B20-B22)', () => {
  it('by requestId and session, or by a token of its group, telling each cancelled, ending a waiting caller, and never touching another call', async () => {
    const webhook = await captureWebhook()
    try {
      const buckle = await node({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'approval-http-admin-token', BUCKLE_APPROVAL_WEBHOOK: webhook.url, BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
      for (const directory of ['one', 'two', 'three']) mkdirSync(join(buckle.workspace, directory))
      const admin = { authorization: 'Bearer approval-http-admin-token', 'content-type': 'application/json' }
      const withdraw = (body: unknown, path = '/setup/approvals/withdraw') => buckle.request(path, { method: 'POST', headers: admin, body: JSON.stringify(body) })
      const invoke = (requestId: string, path: string) => buckle.request('/v1/invoke', { method: 'POST', headers,
        body: JSON.stringify({ requestId, tool: 'fs_write_batch', args: { files: [{ path: `${path}/a.md`, content: 'x' }, { path: `${path}/b/c.md`, content: 'y' }] }, context: { sessionId: 'rings-chat' } }) })

      // A call Rings still waits on: withdrawing ends its wait, as a run cancel would.
      mkdirSync(join(buckle.workspace, 'one', 'b'))
      const waiting = invoke('run-1', 'one')
      await vi.waitFor(() => expect(buckle.runtime.approvals.pending()).toHaveLength(2), { timeout: 10_000 })
      const kept = await (await buckle.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'run-2', tool: 'fs_write', args: { path: 'two/a.md', content: 'x' }, context: { sessionId: 'rings-chat', approvalWait: { mode: 'none' } } }) })).json() as { approvals: Array<{ token: string }> }
      const byRequest = await withdraw({ requestId: 'run-1', sessionId: 'rings-chat' })
      expect(byRequest.status).toBe(200)
      const withdrawn = (await byRequest.json() as { withdrawn: string[] }).withdrawn
      expect(withdrawn).toHaveLength(2)
      expect(await (await waiting).json()).toMatchObject({ requestId: 'run-1', outcome: 'error', error: { code: 'APPROVAL_UNANSWERED' } })
      expect(buckle.runtime.approvals.pending().map(request => request.token)).toEqual(kept.approvals.map(request => request.token))

      // By a token of the group, under the workspace twin; a second withdraw finds nothing and says so.
      mkdirSync(join(buckle.workspace, 'three', 'b'))
      const three = await (await buckle.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'run-3', tool: 'fs_write_batch', args: { files: [{ path: 'three/a.md', content: 'x' }, { path: 'three/b/c.md', content: 'y' }] }, context: { sessionId: 'rings-chat', approvalWait: { mode: 'none' } } }) })).json() as { approvals: Array<{ token: string }> }
      const byToken = await withdraw({ token: three.approvals[0]!.token }, '/workspaces/default/setup/approvals/withdraw')
      expect((await byToken.json() as { withdrawn: string[] }).withdrawn.sort()).toEqual(three.approvals.map(request => request.token).sort())
      expect(await (await withdraw({ token: three.approvals[0]!.token })).json()).toEqual({ withdrawn: [], dropped: [] })
      expect(buckle.runtime.approvals.pending().map(request => request.token)).toEqual(kept.approvals.map(request => request.token))

      expect((await withdraw({ requestId: 'run-1' })).status).toBe(400)
      expect((await withdraw({ token: 'x', approved: true })).status).toBe(400)
      await buckle.runtime.approvalService.close()
      const cancelled = webhook.notices.filter(notice => notice.event === 'cancelled').map(notice => notice.token).sort()
      expect(cancelled).toEqual([...withdrawn, ...three.approvals.map(request => request.token)].sort())
      const audited = buckle.runtime.actions.read(50).filter(entry => entry.tool === 'setup_post_approvals-withdraw' && entry.event === 'result')
      expect(audited.map(entry => entry.detail)).toEqual(['HTTP 200', 'HTTP 200', 'HTTP 200', 'HTTP 400', 'HTTP 400'])
      // Each withdraw names what it withdrew, under the selector as the node keeps it: a requestId hashed (review L14 of B23-B25).
      expect(audited[0]!.args).toEqual({ selector: { requestId: requestIdKey('run-1'), sessionId: 'rings-chat' }, withdrawn, dropped: [] })
      expect(audited[1]!.args).toEqual({ selector: { token: three.approvals[0]!.token }, withdrawn: expect.arrayContaining(three.approvals.map(request => request.token)), dropped: [] })
      expect(JSON.stringify(audited)).not.toContain('"run-1"')
    } finally {
      await webhook.close()
    }
  })
})
