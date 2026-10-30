import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyCommand } from '../../cli/copy.js'
import { FILES_HOLD_MS } from '../../layers/common/server/utils/files.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// The files face behind `buckle cp` (the copy-verb brief): PUT /v1/files judges fs_receive before it reads a byte of the
// body, and GET /v1/files streams a file fs_send judged, each with its /workspaces/[id]/ twin, under the same policy,
// approvals, and audit as /v1/invoke.

const TOKEN = 'files-http-agent-token-fixture'
const LIMIT = 4 * 1_048_576
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let buckle: BuckleHttp
let workspace: string
let state: string
beforeEach(async () => {
  const node = nodeEnvironment('buckle-files-', { BUCKLE_AUTH_TOKEN: TOKEN, BUCKLE_PACKS: 'fs', BUCKLE_MAX_TRANSFER_BYTES: String(LIMIT) })
  workspace = node.workspace
  state = node.state
  buckle = await createBuckleHttp({ environment: node.environment })
})
afterEach(() => buckle.close())

/** Writes in the workspace go ahead for the session every caller that names none shares, as a session grant would. */
async function grantWrites(): Promise<void> {
  await buckle.runtime.grants.grant({ sessionId: 'rpc', rule: 'write_scope', subject: buckle.runtime.paths().root, scope: 'session' })
}

function put(path: string, content: Buffer<ArrayBuffer>, options: { requestId?: string; digest?: string; prefix?: string } = {}): Promise<Response> {
  return buckle.request(`${options.prefix ?? ''}/v1/files?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(content.byteLength), 'x-buckle-sha256': options.digest ?? sha256(content), 'x-buckle-request-id': options.requestId ?? randomUUID() },
    body: content,
  })
}

function get(path: string, options: { requestId?: string; prefix?: string } = {}): Promise<Response> {
  return buckle.request(`${options.prefix ?? ''}/v1/files?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${TOKEN}`, ...(options.requestId ? { 'x-buckle-request-id': options.requestId } : {}) } })
}

const entries = (folder: string) => readdirSync(folder).sort()
const results = (tool: string) => buckle.runtime.actions.read(200).filter(entry => entry.tool === tool && entry.event === 'result')

/** Waits until the audit log holds a result of `tool`, as a call the caller left still records one as it ends. */
async function settled(tool: string, count = 1): Promise<void> {
  const deadline = Date.now() + 10_000
  while (results(tool).length < count) {
    if (Date.now() > deadline) throw new Error(`No ${tool} result was recorded`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

// The MCP asks brief, item 6: whatever the workspace waits, 0 (until decided) or longer than node:http's 300 seconds for
// a request to arrive whole, a copy's call is held for FILES_HOLD_MS at most, so the route answers approval_required
// before node:http cuts the request with 408.
describe('the hold of a copy', () => {
  it.each([null, 600_000])('is FILES_HOLD_MS at most, on PUT and GET alike, at a workspace wait of %s', async (wait) => {
    const managed = await (await buckle.common.services.getWorkspaces()).resolve(buckle.runtime.workspaceId)
    managed.config.approvalTimeoutMs = wait
    const invoke = vi.spyOn(buckle.runtime, 'invoke').mockImplementation(async call => ({ requestId: call.request.requestId, outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'held', retryable: false } }))
    await (await put('held.txt', Buffer.from('held'))).text()
    await (await get('held.txt')).text()
    expect(invoke.mock.calls.map(([call]) => call.approvalWait)).toEqual([{ mode: 'finite', ms: FILES_HOLD_MS }, { mode: 'finite', ms: FILES_HOLD_MS }])
    // A copy is sent again until it is decided, so an ask it leaves at wait 0 may lapse (review of the MCP asks slice, finding M3).
    expect(invoke.mock.calls.map(([call]) => call.resends)).toEqual([true, true])
    expect(FILES_HOLD_MS).toBeLessThan(300_000)
  })
})

describe('PUT /v1/files', () => {
  it('answers approval_required as /v1/invoke does, the body unread, then runs once the ask is approved, joined by its requestId', async () => {
    const content = Buffer.from('a file for the workspace\n')
    const requestId = randomUUID()
    const first = await put('copied.txt', content, { requestId })
    expect(first.status).toBe(200)
    const asked = await first.json() as InvokeResponse
    expect(asked).toMatchObject({ requestId, outcome: 'approval_required', approvals: [{ tool: 'fs_receive', rule: 'write_scope' }] })
    expect(entries(workspace)).toEqual([])
    const token = asked.outcome === 'approval_required' ? asked.approvals[0]!.token : ''
    expect((await buckle.runtime.approvals.resolve({ token, approved: true, scope: 'once' }, 'admin')).ok).toBe(true)

    const again = await put('copied.txt', content, { requestId })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ requestId, outcome: 'ok', output: { path: 'copied.txt', size: content.byteLength, sha256: sha256(content) } })
    expect(readFileSync(join(workspace, 'copied.txt'))).toEqual(content)
    expect(entries(workspace)).toEqual(['copied.txt'])
    expect(results('fs_receive').map(entry => entry.outcome)).toEqual(['approval_required', 'ok'])
    expect(buckle.runtime.approvalService.waiting()).toEqual([])
  })

  it('answers a denied ask as /v1/invoke answers a denial, and writes nothing', async () => {
    const content = Buffer.from('never lands')
    const requestId = randomUUID()
    const asked = await (await put('denied.txt', content, { requestId })).json() as InvokeResponse
    const token = asked.outcome === 'approval_required' ? asked.approvals[0]!.token : ''
    await buckle.runtime.approvals.resolve({ token, approved: false, scope: 'once' }, 'admin')
    const again = await put('denied.txt', content, { requestId })
    expect(again.status).toBe(422)
    expect(await again.json()).toMatchObject({ requestId, outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Approval was declined') } })
    expect(entries(workspace)).toEqual([])
  })

  it('refuses a body over BUCKLE_MAX_TRANSFER_BYTES with 413 before anyone is asked or any byte is kept, and audits the refusal', async () => {
    const response = await put('big.bin', Buffer.alloc(LIMIT + 1))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: `The file is ${LIMIT + 1} bytes, more than the ${LIMIT} this node copies at once (BUCKLE_MAX_TRANSFER_BYTES)` })
    expect(buckle.runtime.approvalService.waiting()).toEqual([])
    expect(results('fs_receive')).toEqual([])
    expect(buckle.runtime.actions.read(1)[0]).toMatchObject({ tool: 'rpc_files_rejected', detail: 'HTTP 413', outcome: 'error' })
    expect(entries(workspace)).toEqual([])
  })

  it.each([
    ['no content-length, as a chunked body has', { 'x-buckle-sha256': 'a'.repeat(64), 'x-buckle-request-id': 'r1' }, 411, 'path=x.txt'],
    ['no digest', { 'content-length': '1', 'x-buckle-request-id': 'r1' }, 400, 'path=x.txt'],
    ['a digest that is not one', { 'content-length': '1', 'x-buckle-sha256': 'nope', 'x-buckle-request-id': 'r1' }, 400, 'path=x.txt'],
    ['no requestId', { 'content-length': '1', 'x-buckle-sha256': 'a'.repeat(64) }, 400, 'path=x.txt'],
    ['no path', { 'content-length': '1', 'x-buckle-sha256': 'a'.repeat(64), 'x-buckle-request-id': 'r1' }, 400, ''],
    ['two paths', { 'content-length': '1', 'x-buckle-sha256': 'a'.repeat(64), 'x-buckle-request-id': 'r1' }, 400, 'path=a&path=b'],
  ])('refuses a request with %s before any call', async (_name, headers, status, query) => {
    const chunked = !('content-length' in headers)
    const response = await buckle.request(`/v1/files?${query}`, {
      method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      ...(chunked ? { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }), duplex: 'half' } : { body: new Uint8Array([1]) }),
    } as RequestInit)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: expect.any(String) })
    expect(results('fs_receive')).toEqual([])
    expect(entries(workspace)).toEqual([])
  })

  it('leaves nothing at the path or beside it where the body does not hash to the digest it named', async () => {
    await grantWrites()
    const response = await put('wrong.txt', Buffer.from('these bytes'), { digest: sha256(Buffer.from('other bytes')) })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ outcome: 'error', error: { code: 'TRANSFER_DIGEST_MISMATCH' } })
    expect(entries(workspace)).toEqual([])
  })

  it.each([
    ['ends its side with fewer bytes than its content-length', 'end'],
    ['drops the connection mid-stream', 'destroy'],
  ] as const)('leaves nothing at the path or beside it where the caller %s', async (_name, how) => {
    await grantWrites()
    const url = new URL(await buckle.listen())
    const whole = Buffer.alloc(256 * 1024, 3)
    const socket = connect({ host: url.hostname, port: Number(url.port) })
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    socket.on('error', () => {})
    socket.write(`PUT /v1/files?path=cut.bin HTTP/1.1\r\nhost: ${url.host}\r\nauthorization: Bearer ${TOKEN}\r\ncontent-length: ${whole.byteLength}\r\nx-buckle-sha256: ${sha256(whole)}\r\nx-buckle-request-id: ${randomUUID()}\r\n\r\n`)
    socket.write(whole.subarray(0, 64 * 1024))
    await new Promise(resolve => setTimeout(resolve, 300))
    if (how === 'end') socket.end()
    else socket.destroy()
    await settled('fs_receive')
    expect(results('fs_receive')[0]?.outcome).toBe('error')
    expect(entries(workspace)).toEqual([])
  })

  it('refuses Buckle\'s state as fs_write does, and a folder as the target, naming the copy\'s way into it', async () => {
    await grantWrites()
    const planted = await put(join(state, 'planted.txt'), Buffer.from('x'))
    expect(await planted.json()).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    mkdirSync(join(workspace, 'dist'))
    const folder = await put('dist', Buffer.from('x'))
    expect(folder.status).toBe(422)
    expect(await folder.json()).toMatchObject({ outcome: 'error', error: { code: 'TARGET_IS_DIRECTORY' } })
    expect(entries(join(workspace, 'dist'))).toEqual([])
  })

  it('serves the workspace its path names on the /workspaces/[id]/ twin, and records each copy with its path, bytes, digest, and actor, and never the token', async () => {
    await grantWrites()
    const content = Buffer.from('through the twin')
    const response = await put('twin.txt', content, { prefix: `/workspaces/${buckle.runtime.workspaceId}` })
    expect(await response.json()).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'twin.txt'))).toEqual(content)
    const [result] = results('fs_receive')
    expect(result).toMatchObject({ tool: 'fs_receive', outcome: 'ok', actorId: 'agent:node', actorTrust: 'authenticated', args: { path: 'twin.txt', bytes: content.byteLength, sha256: sha256(content) } })
    expect(JSON.stringify(buckle.runtime.actions.read(200))).not.toContain(TOKEN)
    expect(JSON.stringify(buckle.nodeActions.read(200))).not.toContain(TOKEN)
  })
})

describe('GET /v1/files', () => {
  it('streams the file with its content-length and sha256 ahead of it, over the wire serve uses', async () => {
    const content = Buffer.alloc(3 * 1_048_576 + 5, 0)
    for (let index = 0; index < content.byteLength; index += 997) content[index] = index % 251
    writeFileSync(join(workspace, 'out.bin'), content)
    const url = new URL(await buckle.listen())
    const answer = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const request = httpRequest({ host: url.hostname, port: url.port, path: '/v1/files?path=out.bin', headers: { authorization: `Bearer ${TOKEN}` } }, (response) => {
        const parts: Buffer[] = []
        response.on('data', (chunk: Buffer) => parts.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(parts) }))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('application/octet-stream')
    expect(answer.headers['content-length']).toBe(String(content.byteLength))
    expect(answer.headers['x-buckle-sha256']).toBe(sha256(content))
    expect(sha256(answer.body)).toBe(sha256(content))
    await settled('fs_send')
    expect(results('fs_send')[0]).toMatchObject({ outcome: 'ok', effects: ['read_path'], args: { path: 'out.bin', bytes: content.byteLength, sha256: sha256(content) } })
  })

  it('judges the read: a credential file answers approval_required, and its bytes only once approved', async () => {
    writeFileSync(join(workspace, '.env'), 'KEY=value\n')
    const requestId = randomUUID()
    const first = await get('.env', { requestId })
    expect(first.headers.get('content-type')).toContain('application/json')
    const asked = await first.json() as InvokeResponse
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ tool: 'fs_send', rule: 'sensitive_path' }] })
    const token = asked.outcome === 'approval_required' ? asked.approvals[0]!.token : ''
    await buckle.runtime.approvals.resolve({ token, approved: true, scope: 'once' }, 'admin')
    const again = await get('.env', { requestId })
    expect(again.status).toBe(200)
    expect(again.headers.get('x-buckle-sha256')).toBe(sha256(Buffer.from('KEY=value\n')))
    expect(await again.text()).toBe('KEY=value\n')
  })

  it('answers a re-send of a call that sent its file already with 409, as its bytes are not kept, and a missing file with its refusal', async () => {
    writeFileSync(join(workspace, 'once.txt'), 'sent once')
    const requestId = randomUUID()
    expect(await (await get('once.txt', { requestId })).text()).toBe('sent once')
    await settled('fs_send')
    const again = await get('once.txt', { requestId })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ requestId, outcome: 'error', error: { code: 'REQUEST_ALREADY_EXECUTED' } })
    const missing = await get('none.txt')
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ outcome: 'error' })
  })

  it('reports the limit in the manifest, beside the others', async () => {
    const manifest = await (await buckle.request('/v1/manifest', { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { limits: Record<string, number>; tools: Array<{ name: string }> }
    expect(manifest.limits).toMatchObject({ maxTransferBytes: LIMIT, maxRequestBytes: expect.any(Number) })
    expect(manifest.tools.map(tool => tool.name)).not.toContain('fs_receive')
  })
})

describe('buckle cp against this node', () => {
  it('copies a file in once a person approves it, back out, and in again by the workspace\'s id, the digests matching each way', async () => {
    const node = await buckle.listen()
    const here = mkdtempSync(join(tmpdir(), 'files-cp-'))
    const content = Buffer.alloc(3 * 1_048_576, 0)
    for (let index = 0; index < content.byteLength; index += 4093) content[index] = index % 241
    writeFileSync(join(here, 'app.tgz'), content)
    let out = ''
    let err = ''
    const io = { stdout: { write: (text: string) => { out += text } }, stderr: { write: (text: string) => { err += text } }, pollMs: 20, running: async () => null }
    const workspaceName = buckle.runtime.workspaceName()

    // In: the first write to the folder asks; the copy waits, then runs once the ask is approved at the node.
    const copying = copyCommand([join(here, 'app.tgz'), `${workspaceName}:`, '--node', node], { BUCKLE_AUTH_TOKEN: TOKEN }, io)
    const token = await Promise.race([waitingToken('fs_receive'), copying.then((result) => { throw new Error(`buckle cp ended before it asked: ${JSON.stringify(result)} ${err}`) })])
    // The ask is registered before the node answers the held PUT with it: approve once the copy has said it is waiting.
    await until(() => err.includes('Waiting for approval of write_scope '))
    await buckle.runtime.approvals.resolve({ token, approved: true, scope: 'always' }, 'admin')
    expect(await copying).toEqual({ exitCode: 0 })
    expect(err).toContain(`then approve with: buckle approve ${token} --scope once --workspace ${workspaceName}`)
    expect(out).toBe(`Copied ${content.byteLength} bytes to ${workspaceName}:app.tgz (sha256 ${sha256(content)})\n`)
    expect(sha256(readFileSync(join(workspace, 'app.tgz')))).toBe(sha256(content))

    // Out: a read in the workspace runs without asking.
    out = ''
    expect(await copyCommand([`${workspaceName}:app.tgz`, join(here, 'back.tgz'), '--node', node], { BUCKLE_AUTH_TOKEN: TOKEN }, io)).toEqual({ exitCode: 0 })
    expect(sha256(readFileSync(join(here, 'back.tgz')))).toBe(sha256(content))
    expect(out).toBe(`Copied ${content.byteLength} bytes to ${join(here, 'back.tgz')} (sha256 ${sha256(content)})\n`)

    // Again: the copy that came out, in under the workspace's id and a folder, the standing grant applying.
    out = ''
    mkdirSync(join(workspace, 'copies'))
    expect(await copyCommand([join(here, 'back.tgz'), `${buckle.runtime.workspaceId}:copies`, '--node', node], { BUCKLE_AUTH_TOKEN: TOKEN }, io)).toEqual({ exitCode: 0 })
    expect(out).toBe(`Copied ${content.byteLength} bytes to ${buckle.runtime.workspaceId}:copies/back.tgz (sha256 ${sha256(content)})\n`)
    expect(sha256(readFileSync(join(workspace, 'copies', 'back.tgz')))).toBe(sha256(content))
    // Each folder target is refused as one before anyone is asked, and sent again by the file's name.
    expect(results('fs_receive').map(entry => [entry.outcome, entry.detail ?? null])).toEqual([['error', 'TARGET_IS_DIRECTORY'], ['approval_required', null], ['ok', null], ['error', 'TARGET_IS_DIRECTORY'], ['ok', null]])
    // Each copy ran in a session of its own, which no caller can name ahead of it.
    const sessions = results('fs_receive').map(entry => entry.sessionId)
    expect(sessions.every(id => /^buckle-cp-[0-9a-f-]{36}$/.test(String(id)))).toBe(true)
    expect(new Set(sessions).size).toBe(2)
  })
})

/** Resolves once `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition never held')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The token of the first ask `tool` leaves waiting, once it has. */
async function waitingToken(tool: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const ask = buckle.runtime.approvalService.waiting().find(item => item.request.tool === tool)
    if (ask) return ask.request.token
    if (Date.now() > deadline) throw new Error(`No ${tool} ask is waiting`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
