import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// The MCP face over HTTP on the MCP layer (B16): initialize, a tool call relayed through the invoker,
// 405 with Allow for other methods, a cancelled call, and the workspace twin.

const TOKEN = 'mcp-http-agent-token'
const ADMIN = 'mcp-http-admin-token'
const PROTOCOL = '2026-07-28'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

async function node(extra: Record<string, string> = {}): Promise<BuckleHttp & { root: string; workspace: string }> {
  const { root, workspace, environment } = nodeEnvironment('buckle-mcp-http-', { BUCKLE_AUTH_TOKEN: TOKEN, BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs', ...extra })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  return Object.assign(started, { root, workspace })
}

function headers(token = TOKEN, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }
}

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mcp-http-test', version: '0' } } })

function toolCall(name: string, args: Record<string, unknown>): { body: string; headers: Record<string, string> } {
  return {
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    headers: { 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': name },
  }
}

describe('the MCP face over HTTP', () => {
  it('answers initialize with the node\'s server info, audited as transport status', async () => {
    const buckle = await node()
    const response = await buckle.request('/mcp', { method: 'POST', headers: headers(), body: initialize })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(buckle.config.serverName)
    const tools = buckle.runtime.actions.read(20).map(entry => `${entry.tool}:${entry.event}:${entry.outcome}`)
    expect(tools).toEqual(expect.arrayContaining(['http_mcp_post:attempt:started', 'http_mcp_post:result:ok']))
  })

  it('relays a tool call through the invoker, and an approval it needs as text', async () => {
    const buckle = await node()
    writeFileSync(join(buckle.workspace, 'note.md'), 'relayed content')
    const read = toolCall('fs_read', { path: 'note.md' })
    const response = await buckle.request('/mcp', { method: 'POST', headers: headers(TOKEN, read.headers), body: read.body })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('relayed content')
    expect(buckle.runtime.actions.read(20)).toContainEqual(expect.objectContaining({ tool: 'fs_read', event: 'result', outcome: 'ok' }))

    const write = toolCall('fs_write', { path: join(buckle.root, 'outside.md'), content: 'x' })
    const gated = await buckle.request('/mcp', { method: 'POST', headers: headers(TOKEN, write.headers), body: write.body })
    expect(await gated.text()).toContain('This call needs approval')
  })

  it('answers every method but POST with a JSON-RPC 405 and Allow: POST, after the credential', async () => {
    const buckle = await node()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect((await buckle.request('/mcp', { method })).status).toBe(401)
      const response = await buckle.request('/mcp', { method, headers: headers(), ...(['PUT', 'PATCH'].includes(method) ? { body: initialize } : {}) })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
  })

  it('cancels a call the client abandons while it waits for approval, leaving nothing pending', async () => {
    const buckle = await node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const write = toolCall('fs_write', { path: join(buckle.root, 'abandoned.md'), content: 'x' })
    const controller = new AbortController()
    const waiting = buckle.request('/mcp', { method: 'POST', headers: headers(TOKEN, write.headers), body: write.body, signal: controller.signal }).then(response => response.text()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(buckle.runtime.approvals.pending()).toHaveLength(1), { timeout: 10_000 })

    controller.abort()
    await waiting

    await vi.waitFor(() => expect(buckle.runtime.approvals.pending()).toEqual([]), { timeout: 10_000 })
    expect(buckle.runtime.actions.read(50)).toContainEqual(expect.objectContaining({ tool: 'fs_write', event: 'result' }))
  })

  it('serves a registered workspace at /workspaces/[id]/mcp under its own agent token only', async () => {
    const buckle = await node()
    const one = join(buckle.root, 'one')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(one)
    writeFileSync(join(one, 'note.md'), 'workspace one content')
    const agent = 'workspace-one-mcp-agent-token-fixture'
    expect((await buckle.request('/setup/workspaces', { method: 'POST', headers: headers(ADMIN), body: JSON.stringify({ id: 'one', name: 'One', root: one, authToken: agent, adminToken: 'workspace-one-mcp-admin-token-fixture' }) })).status).toBe(201)

    expect((await buckle.request('/workspaces/one/mcp', { method: 'POST', headers: headers(), body: initialize })).status).toBe(401)
    expect(buckle.runtime.actions.read(20)).toContainEqual(expect.objectContaining({ tool: 'workspace_mcp_auth_rejected', workspaceId: 'one', outcome: 'denied' }))
    const read = toolCall('fs_read', { path: '/workspace/note.md' })
    const response = await buckle.request('/workspaces/one/mcp', { method: 'POST', headers: headers(agent, read.headers), body: read.body })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('workspace one content')
  })

  it('keeps one tools-changed listener per workspace runtime however many requests it serves (review L7 of B15-B17)', async () => {
    const buckle = await node()
    const listen = vi.spyOn(buckle.runtime, 'onToolsChanged')
    for (let index = 0; index < 8; index += 1) {
      const response = await buckle.request('/mcp', { method: 'POST', headers: headers(), body: initialize })
      expect(response.status).toBe(200)
      await response.text()
    }
    const list = toolList()
    expect((await buckle.request('/mcp', { method: 'POST', headers: headers(TOKEN, list.headers), body: list.body })).status).toBe(200)
    expect(listen).toHaveBeenCalledTimes(1)
  })

  it('tells an open subscription the tool list changed when the runtime reloads (review L7 of B15-B17)', async () => {
    const buckle = await node()
    const listen = subscribe()
    const response = await buckle.request('/mcp', { method: 'POST', headers: headers(TOKEN, listen.headers), body: listen.body })
    expect(response.status).toBe(200)
    const events = sseMessages(response)
    expect(await events.next()).toMatchObject({ method: 'notifications/subscriptions/acknowledged' })
    await buckle.runtime.reload()
    expect(await events.next()).toMatchObject({ method: 'notifications/tools/list_changed' })
    await events.stop()
  })
})

function toolList(): { body: string; headers: Record<string, string> } {
  return {
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    headers: { 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/list' },
  }
}

function subscribe(): { body: string; headers: Record<string, string> } {
  return {
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true }, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    headers: { 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'subscriptions/listen' },
  }
}

/** The JSON-RPC messages of an SSE body, one at a time (frames without data, such as keepalives, skipped), and a way to hang up. */
function sseMessages(response: Response): { next(): Promise<unknown>; stop(): Promise<void> } {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  const dataOf = (frame: string) => frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
  let buffer = ''
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end < 0) {
          const { value, done } = await reader.read()
          if (done) throw new Error('The stream ended before the next message')
          buffer += value
          continue
        }
        const data = dataOf(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (data) return JSON.parse(data) as unknown
      }
    },
    stop: () => reader.cancel(),
  }
}
