import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

const TOKEN = 'correct-horse-battery-staple'
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
})

let buckle: BuckleHttp

beforeAll(async () => {
  buckle = await createBuckleHttp({ environment: nodeEnvironment('buckle-auth-', { BUCKLE_AUTH_TOKEN: TOKEN }).environment })
})
afterAll(() => buckle.close())

async function mcpRequest(headers: Record<string, string>): Promise<Response> {
  return await buckle.request('/mcp', {
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
    expect((await buckle.request('/v1/manifest')).status).toBe(401)
  })

  it('refuses a wrong token, a prefix of the real one and a non-bearer scheme', async () => {
    for (const authorization of [`Bearer ${TOKEN}-wrong`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, 'Bearer ']) {
      expect((await buckle.request('/v1/manifest', { headers: { authorization } })).status).toBe(401)
    }
  })

  it('serves the manifest to a caller holding the token', async () => {
    const response = await buckle.request('/v1/manifest', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(response.status).toBe(200)
  })
})
