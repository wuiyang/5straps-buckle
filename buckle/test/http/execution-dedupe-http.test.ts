import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, mintedToken, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Review M2 of B13-B14 over HTTP: the guard's actor is part of the key, so a re-send under the same
// token replays, and the same requestId under another token of the workspace is a call of its own.

const NODE_AGENT = 'dedupe-http-node-agent-token'
const ADMIN = 'dedupe-http-admin-token-fixture'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function workspaceOne(): Promise<{ buckle: BuckleHttp; root: string; first: string; minted: string }> {
  const { root, environment } = nodeEnvironment('buckle-dedupe-http-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
  const buckle = await createBuckleHttp({ environment })
  nodes.push(buckle)
  mkdirSync(join(root, 'one'))
  writeFileSync(join(root, 'one', 'note.md'), 'first body')
  const first = await mintedToken(buckle.request('/setup/workspaces', { method: 'POST', headers: headers(ADMIN), body: JSON.stringify({ id: 'one', name: 'one', dir: join(root, 'one') }) }))
  const minted = await buckle.request('/setup/workspaces/one/tokens', { method: 'POST', headers: headers(ADMIN), body: '{}' })
  expect(minted.status).toBe(201)
  return { buckle, root, first, minted: (await minted.json() as { token: { token: string } }).token.token }
}

function invoke(buckle: BuckleHttp, token: string, requestId: string): Promise<Response> {
  return buckle.request('/workspaces/one/v1/invoke', { method: 'POST', headers: headers(token), body: JSON.stringify({ requestId, tool: 'fs_read', args: { path: '/workspace/note.md' }, context: { sessionId: 'chat-1' } }) })
}

describe('a re-sent /v1/invoke', () => {
  it('answers the first run under the same token, and runs again under another token of the workspace', async () => {
    const { buckle, root, first: token, minted } = await workspaceOne()
    const first = await invoke(buckle, token, 'http-1')
    expect(first.status).toBe(200)
    const body = await first.json()
    expect(body).toMatchObject({ outcome: 'ok', output: { content: 'first body' } })
    writeFileSync(join(root, 'one', 'note.md'), 'second body')

    const again = await invoke(buckle, token, 'http-1')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(body)

    const other = await invoke(buckle, minted, 'http-1')
    expect(await other.json()).toMatchObject({ outcome: 'ok', output: { content: 'second body' } })
  })
})
