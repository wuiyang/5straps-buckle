import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { createRuntime } from '../src/runtime.js'

const TOKEN = 'correct-horse-battery-staple'
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
})

let app: Hono

beforeAll(async () => {
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: TOKEN,
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-auth-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
  const runtime = await createRuntime({ config, channel: createDeferredApprovalChannel() })
  app = createHttpApp({ config, runtime, authToken: TOKEN })
})

async function mcpRequest(headers: Record<string, string>): Promise<Response> {
  return await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: INITIALIZE,
  })
}

describe('the MCP face over HTTP', () => {
  it('refuses a request carrying no token', async () => {
    expect((await mcpRequest({})).status).toBe(401)
  })

  it('refuses a wrong token', async () => {
    expect((await mcpRequest({ authorization: `Bearer ${TOKEN}-wrong` })).status).toBe(401)
  })

  it('refuses a token that is a prefix of the real one', async () => {
    expect((await mcpRequest({ authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401)
  })

  it('refuses a non-bearer authorization scheme', async () => {
    expect((await mcpRequest({ authorization: `Basic ${TOKEN}` })).status).toBe(401)
  })

  it('accepts the correct token', async () => {
    expect((await mcpRequest({ authorization: `Bearer ${TOKEN}` })).status).not.toBe(401)
  })
})

describe('the native RPC face', () => {
  it('refuses an unauthenticated manifest read', async () => {
    expect((await app.request('/v1/manifest')).status).toBe(401)
  })

  it('serves the manifest to a caller holding the token', async () => {
    const response = await app.request('/v1/manifest', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(response.status).toBe(200)
  })

  it('leaves health open, since it reports nothing actionable', async () => {
    expect((await app.request('/health')).status).toBe(200)
  })
})
