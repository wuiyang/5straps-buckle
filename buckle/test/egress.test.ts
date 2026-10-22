import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFromEnvironment } from './support/workspace-config.js'
import { compileUrlPatterns, matchingHostEntry } from '../common/domain/url-pattern.js'
import { guardedFetch } from '../common/services/packs/web/egress.js'

/** Redirects to whatever the `to` query parameter says, so a hop chain can be exercised. */
function startRedirectServer(): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const target = url.searchParams.get('to')
      if (target) {
        response.writeHead(302, { location: target })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('arrived')
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

describe('guardedFetch', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    const started = await startRedirectServer()
    server = started.server
    port = started.port
  })

  afterAll(() => {
    server.close()
  })

  const allowLocal = () => [`127.0.0.1:${port}`]
  /** The workspace's URL list naming the test server's host exactly (Phase 2 item 5). */
  const listLocal = () => compileUrlPatterns(allowLocal())
  /** No list, and an approval covering the test server alone, as the rules answer it. */
  const grantLocal = async (url: URL) => (url.hostname === '127.0.0.1' ? { kind: 'granted' as const } : { kind: 'allowed' as const })

  it('reaches an explicitly allowed private host', async () => {
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      approved: listLocal(),
    })
    expect(await response.text()).toBe('arrived')
  })

  it('refuses a private host that was not allowed', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      approved: null,
    })).rejects.toThrow(/loopback/)
  })

  it('blocks a redirect into the cloud metadata address', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      approved: null, judge: grantLocal,
    })).rejects.toThrow(/link-local/)
  })

  it('blocks a redirect into an RFC1918 address', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=${encodeURIComponent('http://10.1.2.3/internal')}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      approved: null, judge: grantLocal,
    })).rejects.toThrow(/private/)
  })

  it('blocks a redirect that switches to a non-HTTP scheme', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=${encodeURIComponent('file:///etc/passwd')}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      approved: listLocal(),
    })).rejects.toThrow(/non-HTTP scheme/)
  })

  it('stops a redirect loop rather than following it forever', async () => {
    const self = `http://127.0.0.1:${port}/`
    await expect(guardedFetch({
      url: new URL(`${self}?to=${encodeURIComponent(`${self}?to=${encodeURIComponent(self)}`)}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      approved: listLocal(),
    })).resolves.toBeDefined()
  })

  it('reaches a private host the permission rules say an approval covers', async () => {
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: null,
      judge: async () => ({ kind: 'granted' }),
    })
    expect(await response.text()).toBe('arrived')
  })

  it('refuses with the rules\' reason when they would deny or ask', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: null,
      judge: async () => ({ kind: 'refused', reason: '127.0.0.1 is in the loopback range' }),
    })).rejects.toThrow(/loopback/)
  })

  it('still checks where a name resolves when no approval is involved', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: null,
      judge: async () => ({ kind: 'allowed' }),
    })).rejects.toThrow(/loopback/)
  })

  // Phase 2 item 5: one URL list per workspace, where an entry naming a host exactly clears its private address.
  it('lets a list entry naming the host exactly reach its private address, with no rule consulted', async () => {
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: listLocal(),
      judge: async () => ({ kind: 'refused', reason: 'not consulted' }),
    })
    expect(await response.text()).toBe('arrived')
    const prefixed = await guardedFetch({ url: new URL(`http://localhost:${port}/`), method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000), approved: compileUrlPatterns([`http://localhost:${port}`]) })
    expect(await prefixed.text()).toBe('arrived')
  })

  it('never lets a wildcard entry clear a private address: the host it covers is refused where it resolves into one', async () => {
    await expect(guardedFetch({
      url: new URL(`http://localhost:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: compileUrlPatterns([`*.localhost:${port}`]),
      judge: async () => ({ kind: 'granted' }),
    })).rejects.toThrow(/loopback/)
  })

  it('holds each redirect hop to the list, and refuses a host it does not cover', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=http://localhost:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: compileUrlPatterns([...allowLocal(), '*.localhost']),
    })).rejects.toThrow(/loopback/)
    await expect(guardedFetch({
      url: new URL(`http://localhost:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: compileUrlPatterns(['*.internal.test']),
    })).rejects.toThrow(/is not on the workspace's approved list/)
  })
})

interface RecordedHop { port: number; method: string; path: string; headers: IncomingHttpHeaders; body: string }

describe('guardedFetch across redirect hops', () => {
  const hops: RecordedHop[] = []
  const servers: Server[] = []
  let firstPort = 0
  let secondPort = 0

  /** Records every request, answers `/start?status=N&to=URL` with that redirect, and anything else with 200. */
  function startRecorder(): Promise<number> {
    return new Promise(resolve => {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const port = (server.address() as AddressInfo).port
          hops.push({ port, method: request.method ?? '', path: url.pathname, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
          if (url.pathname === '/start') {
            response.writeHead(Number(url.searchParams.get('status')), { location: url.searchParams.get('to') ?? '/' })
            response.end()
            return
          }
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('arrived')
        })
      })
      servers.push(server)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })
  }

  beforeAll(async () => {
    firstPort = await startRecorder()
    secondPort = await startRecorder()
  })

  afterAll(() => {
    for (const server of servers) server.close()
  })

  beforeEach(() => {
    hops.length = 0
  })

  const approvedBoth = () => compileUrlPatterns([`127.0.0.1:${firstPort}`, `127.0.0.1:${secondPort}`])

  /** Sends `method` to a hop answering `status`, redirecting to `to`, and returns the request the second hop received. */
  async function followed(status: number, method: string, options: { to?: string; body?: string; headers?: Record<string, string> } = {}): Promise<RecordedHop> {
    const target = new URL(`http://127.0.0.1:${firstPort}/start?status=${status}&to=${encodeURIComponent(options.to ?? '/final')}`)
    const response = await guardedFetch({ url: target, method, headers: options.headers ?? {}, body: options.body, signal: AbortSignal.timeout(5_000), approved: approvedBoth() })
    expect(response.status).toBe(200)
    await response.text()
    expect(hops).toHaveLength(2)
    expect(hops[0]).toMatchObject({ method, path: '/start' })
    return hops[1]!
  }

  const bodyHeaders = { 'Content-Type': 'application/json', 'Content-Language': 'en', 'Content-Location': '/orders/1', 'X-Plain': 'kept' }

  it.each([301, 302])('follows a %i answer to a POST with GET, no body, and none of the body headers', async status => {
    const hop = await followed(status, 'POST', { body: '{"order":1}', headers: bodyHeaders })
    expect(hop.method).toBe('GET')
    expect(hop.body).toBe('')
    expect(hop.headers['content-type']).toBeUndefined()
    expect(hop.headers['content-length']).toBeUndefined()
    expect(hop.headers['content-language']).toBeUndefined()
    expect(hop.headers['content-location']).toBeUndefined()
    expect(hop.headers['x-plain']).toBe('kept')
  })

  it('drops a caller-set content-length and content-encoding with the body, whatever their case', async () => {
    const hop = await followed(302, 'POST', { body: 'abc', headers: { 'CONTENT-LENGTH': '3', 'Content-Encoding': 'identity', 'X-Plain': 'kept' } })
    expect(hop.method).toBe('GET')
    expect(hop.body).toBe('')
    expect(hop.headers['content-length']).toBeUndefined()
    expect(hop.headers['content-encoding']).toBeUndefined()
    expect(hop.headers['x-plain']).toBe('kept')
  })

  it.each(['PUT', 'PATCH', 'DELETE', 'POST'])('follows a 303 answer to a %s with GET and no body', async method => {
    const hop = await followed(303, method, { body: 'payload', headers: bodyHeaders })
    expect(hop.method).toBe('GET')
    expect(hop.body).toBe('')
    expect(hop.headers['content-type']).toBeUndefined()
    expect(hop.headers['x-plain']).toBe('kept')
  })

  it('keeps GET and HEAD on a 303 answer', async () => {
    expect((await followed(303, 'GET', { headers: { 'X-Plain': 'kept' } })).method).toBe('GET')
    hops.length = 0
    expect((await followed(303, 'HEAD')).method).toBe('HEAD')
  })

  it.each([301, 302])('keeps a PUT on a %i answer, the fetch standard changing only a POST', async status => {
    const hop = await followed(status, 'PUT', { body: 'payload', headers: bodyHeaders })
    expect(hop.method).toBe('PUT')
    expect(hop.body).toBe('payload')
    expect(hop.headers['content-type']).toBe('application/json')
  })

  it.each([307, 308])('keeps the method, the body, and the body headers on a %i answer', async status => {
    const hop = await followed(status, 'POST', { body: '{"order":1}', headers: bodyHeaders })
    expect(hop.method).toBe('POST')
    expect(hop.body).toBe('{"order":1}')
    expect(hop.headers['content-type']).toBe('application/json')
    expect(hop.headers['content-language']).toBe('en')
    expect(hop.headers['x-plain']).toBe('kept')
  })

  it('drops authorization, cookie, and proxy-authorization on a hop to another port, and keeps a plain header', async () => {
    const credentials = { Authorization: 'Bearer decoy', Cookie: 'session=planted', 'Proxy-Authorization': 'Basic decoy', 'X-Plain': 'kept' }
    const hop = await followed(302, 'GET', { to: `http://127.0.0.1:${secondPort}/final`, headers: credentials })
    expect(hop.port).toBe(secondPort)
    expect(hop.headers.authorization).toBeUndefined()
    expect(hop.headers.cookie).toBeUndefined()
    expect(hop.headers['proxy-authorization']).toBeUndefined()
    expect(hop.headers['x-plain']).toBe('kept')
  })

  it('keeps authorization and cookie on a hop within the same origin', async () => {
    const hop = await followed(302, 'GET', { headers: { Authorization: 'Bearer decoy', Cookie: 'session=planted', 'X-Plain': 'kept' } })
    expect(hop.port).toBe(firstPort)
    expect(hop.headers.authorization).toBe('Bearer decoy')
    expect(hop.headers.cookie).toBe('session=planted')
    expect(hop.headers['x-plain']).toBe('kept')
  })

  it('does not hand the credentials back once a hop has left the origin', async () => {
    const away = `http://127.0.0.1:${secondPort}/start?status=302&to=${encodeURIComponent(`http://127.0.0.1:${firstPort}/final`)}`
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${firstPort}/start?status=302&to=${encodeURIComponent(away)}`),
      method: 'GET', headers: { Authorization: 'Bearer decoy' }, signal: AbortSignal.timeout(5_000), approved: approvedBoth(),
    })
    await response.text()
    expect(hops.map(hop => hop.port)).toEqual([firstPort, secondPort, firstPort])
    expect(hops[0]!.headers.authorization).toBe('Bearer decoy')
    expect(hops[1]!.headers.authorization).toBeUndefined()
    expect(hops[2]!.headers.authorization).toBeUndefined()
  })

  it('still holds a changed-method hop to the list', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${firstPort}/start?status=303&to=${encodeURIComponent(`http://127.0.0.1:${secondPort}/final`)}`),
      method: 'POST', headers: {}, body: 'payload', signal: AbortSignal.timeout(5_000), approved: compileUrlPatterns([`127.0.0.1:${firstPort}`]),
    })).rejects.toThrow(/is not on the workspace's approved list/)
    expect(hops).toHaveLength(1)
  })
})

describe('guardedFetch and a redirect answer\'s body', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('cancels the body of each redirect answer before the next hop', async () => {
    const cancelled: string[] = []
    const answer = (name: string, init: ResponseInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`body of ${name}`)) },
      cancel() { cancelled.push(name) },
    }), init)
    const stub = vi.fn()
      .mockImplementationOnce(async () => answer('first', { status: 302, headers: { location: '/second' } }))
      .mockImplementationOnce(async () => answer('second', { status: 307, headers: { location: '/third' } }))
      .mockImplementationOnce(async () => new Response('arrived'))
    vi.stubGlobal('fetch', stub)

    const response = await guardedFetch({
      url: new URL('http://decoy.example.test/'), method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: compileUrlPatterns(['decoy.example.test']),
    })

    expect(await response.text()).toBe('arrived')
    expect(stub).toHaveBeenCalledTimes(3)
    expect(cancelled).toEqual(['first', 'second'])
  })
})

describe('a * in a host', () => {
  it('is refused on every hop, whatever list or pattern would otherwise reach it', async () => {
    await expect(guardedFetch({
      url: new URL('http://*.localhost/'),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      approved: compileUrlPatterns(['*.localhost']), judge: async () => ({ kind: 'granted' }),
    })).rejects.toThrow(/A host cannot contain \*/)
  })
})

describe('BUCKLE_ALLOWED_HOSTS at load', () => {
  it('folds into the node\'s URL list, every workspace\'s where it has none of its own', () => {
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-egress-')), BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-egress-state-')), BUCKLE_NETWORK_ALLOW: 'api.example.test', BUCKLE_ALLOWED_HOSTS: 'db.internal, api.example.test' })
    expect(config.policy.network.allow).toEqual(['api.example.test', 'db.internal'])
  })

  it('accepts a pattern and refuses a malformed one, naming the variable', () => {
    const environment = (hosts: string) => ({ BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-egress-')), BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-egress-state-')), BUCKLE_ALLOWED_HOSTS: hosts })
    expect(configFromEnvironment(environment('db.internal, *.internal.test:8080')).policy.network.allow).toEqual(['db.internal', '*.internal.test:8080'])
    expect(() => configFromEnvironment(environment('*.*.test'))).toThrow(/Invalid BUCKLE_ALLOWED_HOSTS entry: A wildcard stands only as the whole leftmost label/)
    expect(() => configFromEnvironment(environment('https://db.internal'))).toThrow(/names no scheme/)
    expect(configFromEnvironment(environment('my_db, my_db:5432, *.compose_net')).policy.network.allow).toEqual(['my_db', 'my_db:5432', '*.compose_net'])
    expect(() => configFromEnvironment(environment('db.internal.'))).toThrow(/Invalid BUCKLE_ALLOWED_HOSTS entry/)
    const v6 = configFromEnvironment(environment('::1:3000, [::1]:3000')).policy.network.allow
    expect(v6).toEqual(['::1:3000', '[::1]:3000'])
    expect(matchingHostEntry(v6.slice(0, 1), new URL('http://[::1]:3000/'))).toBeFalsy()
    expect(matchingHostEntry(v6, new URL('http://[::1]:3000/'))).toBe('[::1]:3000')
    expect(() => configFromEnvironment(environment('my_db:05432'))).toThrow(/Invalid BUCKLE_ALLOWED_HOSTS entry: Not a port/)
    expect(() => configFromEnvironment(environment('*.0.0.1'))).toThrow(/Invalid BUCKLE_ALLOWED_HOSTS entry: A wildcard covers a domain, not an address/)
  })
})
