import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
