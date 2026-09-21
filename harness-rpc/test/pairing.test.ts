import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit } from '../src/faces/cli/init.js'

let root: string
let workspace: string
let out: string
let requests: Array<{ url: string; body: Record<string, unknown> }>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buckle-pairing-'))
  workspace = join(root, 'workspace')
  out = join(root, 'node.env')
  mkdirSync(workspace)
  vi.stubEnv('BUCKLE_STATE_DIR', join(root, 'state'))
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: { body: string }) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
    return new Response(JSON.stringify({ server: { id: 'paired', name: 'Paired' } }), { status: 201, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

function init(extra: string[] = []) {
  return runInit(['--root', workspace, '--out', out, '--name', 'Paired', '--port', '4399', '--yes', ...extra])
}

describe('buckle init --pair', () => {
  it('sends the node URL, both credentials and the manifest in one body, never in argv', async () => {
    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--url', 'http://node.test:4399'])).exitCode).toBe(0)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://rings.test:3001/api/v1/harness-servers/pairing/redeem')
    const written = parseEnv(readFileSync(out, 'utf8'))
    expect(requests[0]!.body).toMatchObject({
      code: 'ABCD-EFGH-JKMN',
      name: 'Paired',
      baseUrl: 'http://node.test:4399',
      authToken: written.BUCKLE_AUTH_TOKEN,
      adminToken: written.BUCKLE_ADMIN_TOKEN,
    })
    expect((requests[0]!.body.manifest as { serverId: string }).serverId).toBe(written.BUCKLE_SERVER_ID)
    expect(process.argv.join(' ')).not.toContain(written.BUCKLE_AUTH_TOKEN)
  })

  it('defaults the node URL to this host and refuses a code with no Rings to redeem it at', async () => {
    expect((await init(['--pair', 'ABCD-EFGH-JKMN'])).exitCode).toBe(1)
    expect(requests).toHaveLength(0)

    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--force'])).exitCode).toBe(0)
    expect(requests[0]!.body.baseUrl).toBe('http://127.0.0.1:4399')
  })

  it('re-pairs a configured node with its existing credentials and the URL it moved to', async () => {
    await init()
    const before = readFileSync(out, 'utf8')

    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--url', 'http://moved.test:4399'])).exitCode).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(before)
    expect(requests[0]!.body).toMatchObject({ baseUrl: 'http://moved.test:4399', authToken: parseEnv(before).BUCKLE_AUTH_TOKEN })
  })

  it('reports a refusal from Rings and keeps the environment file it wrote', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'That pairing code is unknown, already used or expired.' }), { status: 400, headers: { 'content-type': 'application/json' } })))
    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])).exitCode).toBe(1)
    expect(readFileSync(out, 'utf8')).toContain('BUCKLE_ADMIN_TOKEN=')
  })
})
