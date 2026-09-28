import { request as httpRequest } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Review L4 of B13-B14: the body paths of a moved route through the production listener on node:http,
// not only the in-process Request: a chunked body past the limit, and a body streamed in pieces. Since
// B18 the listener is the built entry's middleware (srvx's node adapter), the one serve uses, so a
// client that hangs up is seen through its request signal (condition of the B15-B17 review for B18).

const TOKEN = 'wire-agent-token'
const LIMIT = 4_096
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

async function listening(extra: Record<string, string> = {}): Promise<{ url: string; workspace: string; root: string; buckle: BuckleHttp }> {
  const { root, workspace, environment } = nodeEnvironment('buckle-wire-', { BUCKLE_AUTH_TOKEN: TOKEN, BUCKLE_PACKS: 'fs', BUCKLE_MAX_REQUEST_BYTES: String(LIMIT), ...extra })
  const buckle = await createBuckleHttp({ environment })
  nodes.push(buckle)
  return { url: await buckle.listen(), workspace, root, buckle }
}

interface Reply { status: number; contentType: string | undefined; body: string }

/** POSTs the chunks as a chunked body (no content-length unless given), pausing between them. */
function post(url: string, input: { path: string; chunks: string[]; pauseMs?: number; contentLength?: number }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(input.path, url), {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(input.contentLength === undefined ? {} : { 'content-length': String(input.contentLength) }) },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'], body }))
    })
    // The server may answer 413 and close before the whole body is written.
    request.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error) })
    void (async () => {
      for (const chunk of input.chunks) {
        if (request.destroyed) return
        request.write(chunk)
        if (input.pauseMs) await delay(input.pauseMs)
      }
      request.end()
    })()
  })
}

describe('/v1/invoke over node:http', () => {
  it('answers a chunked body past the limit with the JSON 413, while it streams', async () => {
    const { url } = await listening()
    const reply = await post(url, { path: '/v1/invoke', chunks: Array.from({ length: 8 }, () => 'a'.repeat(1_024)) })
    expect(reply.status).toBe(413)
    expect(reply.contentType).toMatch(/^application\/json/)
    expect(JSON.parse(reply.body)).toEqual({ error: 'Request body is too large' })
  })

  it('answers a declared length past the limit with the JSON 413 before reading it', async () => {
    const { url } = await listening()
    const reply = await post(url, { path: '/v1/invoke', chunks: ['a'.repeat(LIMIT + 1)], contentLength: LIMIT + 1 })
    expect(reply.status).toBe(413)
    expect(JSON.parse(reply.body)).toEqual({ error: 'Request body is too large' })
  })

  it('reads a body streamed in pieces into the route, and the same under /workspaces/default', async () => {
    const { url, workspace } = await listening()
    writeFileSync(join(workspace, 'note.md'), 'streamed through')
    const body = JSON.stringify({ requestId: 'wire-1', tool: 'fs_read', args: { path: 'note.md' } })
    const pieces = [body.slice(0, 10), body.slice(10, 25), body.slice(25)]
    for (const path of ['/v1/invoke', '/workspaces/default/v1/invoke']) {
      const reply = await post(url, { path, chunks: pieces, pauseMs: 20 })
      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body)).toMatchObject({ outcome: 'ok', output: { content: 'streamed through' } })
    }
  })
})

describe('a client that hangs up over node:http', () => {
  // Owner decision D4 (rpc.md: resumable waiting): a dropped transport is not a cancel. HTTP cannot
  // tell the two apart, so the ask stays pending, as after an elapsed hold, and a re-send joins it.
  it('keeps the ask it left waiting for approval; a re-send with the same requestId joins it and the tool runs once', async () => {
    const { url, root, buckle } = await listening({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const body = JSON.stringify({ requestId: 'wire-hang-up', tool: 'fs_write', args: { path: join(root, 'outside.md'), content: 'x' } })
    const request = httpRequest(new URL('/v1/invoke', url), { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    request.on('error', () => undefined)
    request.end(body)
    await vi.waitFor(() => expect(buckle.runtime.approvals.pending()).toHaveLength(1), { timeout: 10_000 })
    const [token] = buckle.runtime.approvals.pending().map(pending => pending.token)

    request.destroy()

    const results = () => buckle.runtime.actions.read(50).filter(entry => entry.event === 'result' && entry.requestId === 'wire-hang-up')
    await vi.waitFor(() => expect(results()).toHaveLength(1), { timeout: 10_000 })
    expect(buckle.runtime.approvals.pending().map(pending => pending.token)).toEqual([token])
    expect(existsSync(join(root, 'outside.md'))).toBe(false)

    const resent = fetch(new URL('/v1/invoke', url), { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body })
    await vi.waitFor(() => expect(buckle.runtime.actions.read(50).filter(entry => entry.event === 'attempt' && entry.requestId === 'wire-hang-up')).toHaveLength(2), { timeout: 10_000 })
    // Joined: no second ask was issued.
    expect(buckle.runtime.approvals.pending().map(pending => pending.token)).toEqual([token])
    expect((await buckle.runtime.approvalService.answer({ decision: { token: token!, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)

    const reply = await resent
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({ requestId: 'wire-hang-up', outcome: 'ok' })
    expect(readFileSync(join(root, 'outside.md'), 'utf8')).toBe('x')
    expect(results().map(entry => entry.outcome).filter(outcome => outcome === 'ok')).toHaveLength(1)
  })
})
