import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Kept from the dispatcher's table (review M1 of B13-B14) once B18 removed the dispatcher: every
// spelling of a path is routed on h3's canonical path (needless escapes decoded, one trailing slash
// ignored, case and slashes kept), in process and through the node:http adapter serve uses.

const rows: Array<{ path: string; status: number }> = [
  { path: '/health', status: 200 },
  { path: '/health/', status: 200 },
  { path: '/%68ealth', status: 200 },
  { path: '/health/%72eady', status: 200 },
  { path: '/health?probe=1', status: 200 },
  { path: '/health/ready?probe=%2F', status: 200 },
  { path: '//health', status: 404 },
  { path: '/HEALTH', status: 404 },
  { path: '/health%2Fready', status: 404 },
  { path: '/nope', status: 404 },
  { path: '/v1/manifest', status: 401 },
  { path: '/v1/%6danifest', status: 401 },
  { path: '/v1//manifest', status: 401 },
  { path: '/workspaces/one/%761/invoke', status: 401 },
  { path: '/workspaces/one/nope', status: 401 },
  { path: '/mcp', status: 401 },
  { path: '/%6dcp', status: 401 },
  { path: '/workspaces/one/%6dcp/', status: 401 },
  { path: '/setup/status', status: 401 },
  { path: '/%73etup/status', status: 401 },
  { path: '/health/../setup/status', status: 401 },
  { path: '/health/%2e%2e/setup/status', status: 401 },
  { path: '/workspaces/one/setup/status', status: 401 },
  { path: '/setup/../../setup/workspaces', status: 401 },
]

let buckle: BuckleHttp
let url: string
beforeAll(async () => {
  buckle = await createBuckleHttp({ environment: nodeEnvironment('buckle-http-spellings-', { BUCKLE_AUTH_TOKEN: 'spellings-agent-token', BUCKLE_ADMIN_TOKEN: 'spellings-admin-token', BUCKLE_PACKS: 'fs' }).environment })
  url = await buckle.listen()
})
afterAll(async () => { await buckle?.close() })

/** One GET over the wire, the path sent exactly as written. */
function wireGet(path: string): Promise<{ status: number; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = httpRequest({ host: target.hostname, port: target.port, path }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'] }))
    })
    request.on('error', reject)
    request.end()
  })
}

describe('every spelling of a path', () => {
  for (const row of rows) {
    it(`${row.path} answers ${row.status} in process and over node:http`, async () => {
      // A full URL, so `//health` stays a path and is not read as a host.
      const response = await buckle.request(`http://127.0.0.1${row.path}`)
      expect(response.status).toBe(row.status)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      await response.body?.cancel()
      const wire = await wireGet(row.path)
      expect(wire.status).toBe(row.status)
      expect(wire.contentType).toMatch(/^application\/json/)
    })
  }
})
