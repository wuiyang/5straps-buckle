import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

let server: Server
let port: number

beforeAll(async () => {
  server = createServer((request, response) => {
    const target = new URL(request.url ?? '/', 'http://localhost').searchParams.get('to')
    if (target) {
      response.writeHead(302, { location: target })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('arrived')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => { server.close() })

async function runtimeWith(environment: Record<string, string> = {}): Promise<BuckleRuntime> {
  const config = configFromEnvironment({
    BUCKLE_AUTH_TOKEN: 'agent',
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-fetch-state-')),
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-fetch-ws-')),
    BUCKLE_ALLOW_SHELL: 'false',
    ...environment,
  })
  return createRuntime({ config })
}

function fetchLocal(runtime: BuckleRuntime, path = '/', approvalTokens: string[] = []): Promise<InvokeResponse> {
  return runtime.invoke({
    request: { requestId: `fetch-${randomUUID()}`, tool: 'web_fetch', args: { url: `http://127.0.0.1:${port}${path}` }, approvalTokens },
    sessionId: 'fetcher',
  })
}

function tokenOf(response: InvokeResponse): string {
  if (response.outcome !== 'approval_required') throw new Error(`expected an approval, got ${response.outcome}`)
  return response.approvals[0]!.token
}

describe('web_fetch and the approvals the owner gave', () => {
  it('reaches a private host the owner approved for the session', async () => {
    const runtime = await runtimeWith()
    const token = tokenOf(await fetchLocal(runtime))
    expect((await runtime.approvals.resolve({ token, approved: true, scope: 'session' }, SOURCES.cli)).ok).toBe(true)
    expect(await fetchLocal(runtime)).toMatchObject({ outcome: 'ok', output: { status: 200, body: 'arrived' } })
  })

  it('reaches a private host approved once, with the token', async () => {
    const runtime = await runtimeWith()
    const token = tokenOf(await fetchLocal(runtime))
    expect((await runtime.approvals.resolve({ token, approved: true, scope: 'once' }, SOURCES.cli)).ok).toBe(true)
    expect(await fetchLocal(runtime, '/', [token])).toMatchObject({ outcome: 'ok', output: { body: 'arrived' } })
  })

  it('still refuses a private host nobody approved', async () => {
    const runtime = await runtimeWith()
    expect((await fetchLocal(runtime)).outcome).toBe('approval_required')
  })

  it('refuses a redirect to a private host the approval did not name', async () => {
    const runtime = await runtimeWith()
    const token = tokenOf(await fetchLocal(runtime, '/?to=http://127.0.0.2/'))
    await runtime.approvals.resolve({ token, approved: true, scope: 'session' }, SOURCES.cli)
    const response = await fetchLocal(runtime, '/?to=http://127.0.0.2/')
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'EGRESS_BLOCKED' } })
    if (response.outcome === 'error') expect(response.error.message).toMatch(/loopback/)
  })
})

describe('web_fetch and an approval widened to a host pattern (BUCKLE-D18)', () => {
  function fetchUrl(runtime: BuckleRuntime, url: string): Promise<InvokeResponse> {
    return runtime.invoke({ request: { requestId: `fetch-${randomUUID()}`, tool: 'web_fetch', args: { url }, approvalTokens: [] }, sessionId: 'fetcher' })
  }

  it('reaches the host that asked under the pattern, and checks every redirect hop against it', async () => {
    const runtime = await runtimeWith()
    const asked = `http://localhost:${port}/`
    const token = tokenOf(await fetchUrl(runtime, asked))
    expect(await runtime.approvals.resolve({ token, approved: true, scope: 'session' }, SOURCES.cli, { widenTo: '*.localhost' })).toMatchObject({ ok: true, widened: { pattern: '*.localhost', askedBy: `localhost:${port}` } })

    expect(await fetchUrl(runtime, asked)).toMatchObject({ outcome: 'ok', output: { body: 'arrived' } })
    const hop = await fetchUrl(runtime, `${asked}?to=http://127.0.0.1:${port}/`)
    expect(hop).toMatchObject({ outcome: 'error', error: { code: 'EGRESS_BLOCKED' } })
    if (hop.outcome === 'error') expect(hop.error.message).toMatch(/loopback/)
  })

  it('never gets a pattern grant past the approved list', async () => {
    const runtime = await runtimeWith({ BUCKLE_NETWORK_ALLOW: 'example.com' })
    await runtime.grants.grant({ sessionId: 'fetcher', rule: 'network_egress', subject: '*.localhost', scope: 'always', pattern: true })

    const response = await fetchUrl(runtime, `http://localhost:${port}/`)
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  })
})
