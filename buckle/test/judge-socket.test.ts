import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocketScanner } from '../common/adapters/package-scan/socket.js'
import { openSocketCache, SOCKET_CACHE_LIMIT, SOCKET_CACHE_TTL_MS, socketCachePath } from '../common/services/judge/socket-cache.js'
import { withSocket } from '../common/services/judge/socket-view.js'
import type { JudgeInput, JudgePackage } from '../common/types/ports/judge.js'
import { npmPackageUrl, PACKAGE_SCAN_LIMIT, type PackageScanner, type SocketSummary } from '../common/types/ports/package-scan.js'

// Socket's view of the packages the code imports (D91, addendum 2 C): looked up by package URL with the node's key as
// HTTP basic auth, on the organization-scoped batch route, kept a day in an owner-only socket-cache.json, and advisory:
// with no key, a timeout, or an error, every summary is null and the rating runs.

const KEY = 'sktsec_socket-fixture-0123456789'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-socket-')))
  roots.push(root)
  return root
}

interface Sent { url: string; method: string; headers: Headers; body: string }

function fakeFetch(answer: (sent: Sent, index: number) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') }
    sent.push(request)
    return answer(request, sent.length - 1)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent }
}

const ORGANIZATIONS = () => Response.json({ organizations: { 'org-id': { id: 'org-id', name: 'Owner', image: null, plan: 'free', slug: 'owner-org' } } })
const artifact = (purl: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id: '1', type: 'npm', name: 'left-pad', version: '1.3.0', inputPurl: purl, score: { overall: 0.82, supplyChain: 0.9, quality: 0.7, maintenance: 0.6, vulnerability: 1, license: 1 }, alerts: [{ key: 'k', type: 'unmaintained', severity: 'low', category: 'maintenance' }], ...extra })
const ndjson = (...lines: string[]) => new Response(`${lines.join('\n')}\n`, { headers: { 'content-type': 'application/x-ndjson' } })
const SUMMARY: SocketSummary = { score: { overall: 0.82, supplyChain: 0.9, quality: 0.7, maintenance: 0.6, vulnerability: 1, license: 1 }, alerts: [{ type: 'unmaintained', severity: 'low' }] }
const LEFT_PAD = npmPackageUrl('left-pad', '1.3.0')

describe('the Socket scanner', () => {
  it('looks up the key\'s organization once, then posts the batch with alerts, the key as basic auth alone', async () => {
    const { fetch, sent } = fakeFetch(({ url }) => (url.endsWith('/v0/organizations') ? ORGANIZATIONS() : ndjson(artifact(LEFT_PAD), JSON.stringify({ _type: 'summary', value: { purl_input: 1, resolved: 1, errors: {} } }))))
    const scanner = createSocketScanner({ apiKey: KEY, fetch })
    expect(await scanner.scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, SUMMARY]]), failed: false })
    expect(await scanner.scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, SUMMARY]]), failed: false })
    expect(sent.map(item => `${item.method} ${item.url}`)).toEqual([
      'GET https://api.socket.dev/v0/organizations',
      'POST https://api.socket.dev/v0/orgs/owner-org/purl?alerts=true',
      'POST https://api.socket.dev/v0/orgs/owner-org/purl?alerts=true',
    ])
    expect(JSON.parse(sent[1]!.body)).toEqual({ components: [{ purl: 'pkg:npm/left-pad@1.3.0' }] })
    for (const request of sent) {
      expect(request.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${KEY}:`).toString('base64')}`)
      expect(request.body).not.toContain(KEY)
      expect(request.url).not.toContain(KEY)
    }
  })

  it('asks the base URL the node names, and writes a scoped name as the purl spec does', async () => {
    const scoped = npmPackageUrl('@types/node', '24.10.1')
    expect(scoped).toBe('pkg:npm/%40types/node@24.10.1')
    const { fetch, sent } = fakeFetch(({ url }) => (url.endsWith('/v0/organizations') ? ORGANIZATIONS() : ndjson(artifact(scoped))))
    await createSocketScanner({ apiKey: KEY, baseUrl: 'http://127.0.0.1:9/socket/', fetch }).scan([scoped])
    expect(sent.map(item => item.url)).toEqual(['http://127.0.0.1:9/socket/v0/organizations', 'http://127.0.0.1:9/socket/v0/orgs/owner-org/purl?alerts=true'])
  })

  it('tries a 429 or a 5xx once more, and answers null for every package on an error, a refusal, or a timeout', async () => {
    let posts = 0
    const retried = fakeFetch(({ url }) => (url.endsWith('/v0/organizations') ? ORGANIZATIONS() : ++posts === 1 ? new Response('busy', { status: 429 }) : ndjson(artifact(LEFT_PAD))))
    expect(await createSocketScanner({ apiKey: KEY, fetch: retried.fetch }).scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, SUMMARY]]), failed: false })
    expect(posts).toBe(2)

    const refused = fakeFetch(() => Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 }))
    // Each failure is told apart from no summary, so a verdict reached without Socket's view is not kept (fix brief 2, H11).
    expect(await createSocketScanner({ apiKey: KEY, fetch: refused.fetch }).scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, null]]), failed: true })
    expect(refused.sent).toHaveLength(1)

    const broken = fakeFetch(({ url }) => (url.endsWith('/v0/organizations') ? ORGANIZATIONS() : new Response('not json at all\n{"_type":"purlError","value":{"error":"x","inputPurl":"y","retryable":false}}')))
    expect(await createSocketScanner({ apiKey: KEY, fetch: broken.fetch }).scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, null]]), failed: false })

    const hanging = fakeFetch(({ url }) => (url.endsWith('/v0/organizations') ? ORGANIZATIONS() : new Promise<Response>(() => {})))
    const started = performance.now()
    expect(await createSocketScanner({ apiKey: KEY, fetch: hanging.fetch, timeoutMs: 50 }).scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, null]]), failed: true })
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})

const fakeScanner = (summary: SocketSummary | null = SUMMARY) => {
  const asked: string[][] = []
  const scanner: PackageScanner = { scan: vi.fn(async (purls: readonly string[]) => { asked.push([...purls]); return { summaries: new Map(purls.map(purl => [purl, summary])), failed: false } }) }
  return { scanner, asked }
}

describe('the Socket cache', () => {
  it('answers a summary it holds for 24 hours without asking, from an owner-only file a restart keeps', async () => {
    const filePath = socketCachePath(scratch())
    let clock = Date.parse('2026-10-18T00:00:00.000Z')
    const { scanner, asked } = fakeScanner()
    const cached = openSocketCache({ scanner, filePath, now: () => clock })
    expect(await cached.scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, SUMMARY]]), failed: false })
    clock += SOCKET_CACHE_TTL_MS - 1
    expect(await openSocketCache({ scanner, filePath, now: () => clock }).scan([LEFT_PAD])).toEqual({ summaries: new Map([[LEFT_PAD, SUMMARY]]), failed: false })
    expect(asked).toHaveLength(1)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    clock += 1
    await cached.scan([LEFT_PAD])
    expect(asked).toHaveLength(2)
  })

  it('takes no summary dated in the future', async () => {
    const filePath = socketCachePath(scratch())
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: [{ purl: LEFT_PAD, at: '2099-01-01T00:00:00.000Z', summary: SUMMARY }] }), { mode: 0o600 })
    const { scanner, asked } = fakeScanner()
    await openSocketCache({ scanner, filePath }).scan([LEFT_PAD])
    expect(asked).toHaveLength(1)
  })

  it('keeps no package Socket answered nothing for, and holds at most its limit', async () => {
    const filePath = socketCachePath(scratch())
    const empty = fakeScanner(null)
    await openSocketCache({ scanner: empty.scanner, filePath }).scan([LEFT_PAD])
    await openSocketCache({ scanner: empty.scanner, filePath }).scan([LEFT_PAD])
    expect(empty.asked).toHaveLength(2)

    const { scanner } = fakeScanner()
    const purls = Array.from({ length: SOCKET_CACHE_LIMIT + 1 }, (_, index) => npmPackageUrl(`p${index}`, '1.0.0'))
    await openSocketCache({ scanner, filePath }).scan(purls)
    const held = JSON.parse(readFileSync(filePath, 'utf8')) as { entries: Array<{ purl: string }> }
    expect(held.entries).toHaveLength(SOCKET_CACHE_LIMIT)
    expect(held.entries[0]!.purl).toBe(purls[1])
  })
})

const INPUT: JudgeInput = {
  command: 'node job.js', argv: ['node', 'job.js'], interpreters: ['node'], inline: null, env: [], files: [],
  packages: [{ name: 'left-pad', version: '1.3.0', socket: null }, { name: 'requests', version: null, socket: null }],
  packagesTruncated: false, truncated: false, standardScript: false,
  policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] }, cwd: '/workspace', mounts: [], description: null, reason: null,
}

describe('what the judge is shown of Socket', () => {
  it('a summary beside each package version, and none for a package without one', async () => {
    const { scanner, asked } = fakeScanner()
    expect((await withSocket(INPUT, scanner)).input.packages).toEqual([{ name: 'left-pad', version: '1.3.0', socket: SUMMARY }, { name: 'requests', version: null, socket: null }])
    expect(asked).toEqual([[LEFT_PAD]])
  })

  it(`at most ${PACKAGE_SCAN_LIMIT} packages a rating, saying so`, async () => {
    const { scanner, asked } = fakeScanner()
    const packages: JudgePackage[] = Array.from({ length: PACKAGE_SCAN_LIMIT + 2 }, (_, index) => ({ name: `p${index}`, version: '1.0.0', socket: null }))
    const { input: shown } = await withSocket({ ...INPUT, packages }, scanner)
    expect(asked[0]).toHaveLength(PACKAGE_SCAN_LIMIT)
    expect(shown.packagesTruncated).toBe(true)
    expect(shown.packages.filter(item => item.socket !== null)).toHaveLength(PACKAGE_SCAN_LIMIT)
  })

  it('a summary for each version of a package, by its own package URL', async () => {
    const summaries = new Map([[npmPackageUrl('lodash', '3.0.0'), { ...SUMMARY, alerts: [{ type: 'old', severity: 'high' }] }], [npmPackageUrl('lodash', '4.17.21'), SUMMARY]])
    const scanner: PackageScanner = { scan: vi.fn(async () => ({ summaries, failed: false })) }
    const { input: shown } = await withSocket({ ...INPUT, packages: [{ name: 'lodash', version: '3.0.0', socket: null }, { name: 'lodash', version: '4.17.21', socket: null }] }, scanner)
    expect(scanner.scan).toHaveBeenCalledWith([npmPackageUrl('lodash', '3.0.0'), npmPackageUrl('lodash', '4.17.21')], undefined)
    expect(shown.packages.map(item => item.socket)).toEqual([summaries.get(npmPackageUrl('lodash', '3.0.0')), SUMMARY])
  })

  it('nothing, and no error, where the scanner fails', async () => {
    const failing: PackageScanner = { scan: () => Promise.reject(new Error('down')) }
    expect(await withSocket(INPUT, failing)).toMatchObject({ input: { packages: [{ socket: null }, { socket: null }] }, failed: true })
  })
})
