import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { guardedFetch } from '../src/packs/web/egress.js'

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

  it('reaches an explicitly allowed private host', async () => {
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      allowedHosts: allowLocal(), approved: null,
    })
    expect(await response.text()).toBe('arrived')
  })

  it('refuses a private host that was not allowed', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      allowedHosts: [], approved: null,
    })).rejects.toThrow(/loopback/)
  })

  it('blocks a redirect into the cloud metadata address', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      allowedHosts: allowLocal(), approved: null,
    })).rejects.toThrow(/link-local/)
  })

  it('blocks a redirect into an RFC1918 address', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=${encodeURIComponent('http://10.1.2.3/internal')}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      allowedHosts: allowLocal(), approved: null,
    })).rejects.toThrow(/private/)
  })

  it('blocks a redirect that switches to a non-HTTP scheme', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/?to=${encodeURIComponent('file:///etc/passwd')}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      allowedHosts: allowLocal(), approved: null,
    })).rejects.toThrow(/non-HTTP scheme/)
  })

  it('stops a redirect loop rather than following it forever', async () => {
    const self = `http://127.0.0.1:${port}/`
    await expect(guardedFetch({
      url: new URL(`${self}?to=${encodeURIComponent(`${self}?to=${encodeURIComponent(self)}`)}`),
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(5_000),
      allowedHosts: allowLocal(), approved: null,
    })).resolves.toBeDefined()
  })

  it('reaches a private host the permission rules say an approval covers', async () => {
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      allowedHosts: [], approved: null,
      judge: () => ({ kind: 'granted' }),
    })
    expect(await response.text()).toBe('arrived')
  })

  it('refuses with the rules\' reason when they would deny or ask', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      allowedHosts: [], approved: null,
      judge: () => ({ kind: 'refused', reason: '127.0.0.1 is in the loopback range' }),
    })).rejects.toThrow(/loopback/)
  })

  it('still checks where a name resolves when no approval is involved', async () => {
    await expect(guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      allowedHosts: [], approved: null,
      judge: () => ({ kind: 'allowed' }),
    })).rejects.toThrow(/loopback/)
  })

  it('lets BUCKLE_ALLOWED_HOSTS reach its host before the rules are consulted', async () => {
    const response = await guardedFetch({
      url: new URL(`http://127.0.0.1:${port}/`),
      method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
      allowedHosts: allowLocal(), approved: null,
      judge: () => ({ kind: 'refused', reason: 'not consulted' }),
    })
    expect(await response.text()).toBe('arrived')
  })
})
