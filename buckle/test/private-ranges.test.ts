import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsCommand } from '../cli/settings.js'
import { cidrRefusal, parseCidr, rangeCovering, type NodeListener } from '../common/domain/ip.js'
import { createNetworkEgressRule } from '../common/domain/permission/rules/network-egress-rule.js'
import { compileUrlPatterns } from '../common/domain/url-pattern.js'
import { judgeUrl } from '../common/domain/url-verdict.js'
import { loadConfig } from '../common/runtime/config.js'
import { guardedFetch } from '../common/services/packs/web/egress.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, resolveSettings, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// APPROVAL-19: config may let network egress reach private, loopback, and reserved addresses without asking, as CIDR
// ranges alone (network.privateRanges, else the node's BUCKLE_NETWORK_PRIVATE_RANGES): never a hostname or a wildcard, so
// what a range exposes is exactly the addresses it names.

let server: Server
let port: number
const roots: string[] = []
const runtimes: CoreRuntime[] = []

beforeAll(async () => {
  server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('arrived') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.close() })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-private-ranges-')))
  roots.push(root)
  return root
}

const ranges = (...texts: string[]) => texts.map(parseCidr)

describe('a private range', () => {
  it.each(['10.0.0.0/8', '192.168.1.0/24', '127.0.0.1/32', 'fd00::/8', '::1/128', 'fe80::/10'])('takes %s', (text) => {
    expect(cidrRefusal(text)).toBeNull()
    expect(parseCidr(text).text).toBe(text)
  })

  it.each([
    ['10.0.0.1', /CIDR/],
    ['localhost', /CIDR/],
    ['db.internal/24', /CIDR/],
    ['*.internal', /CIDR/],
    ['10.0.0.*/24', /CIDR/],
    ['0.0.0.0/0', /at least \/8/],
    ['0.0.0.0/7', /at least \/8/],
    ['::/0', /at least \/8/],
    ['fc00::/7', /at least \/8/],
    ['10.0.0.0/33', /prefix/],
    ['fd00::/129', /prefix/],
    ['10.0.0.0/-1', /prefix/],
    ['10.0.0.0/08', /prefix/],
    ['010.0.0.0/8', /CIDR/],
    ['10.0.0.5/8', /10\.0\.0\.0\/8/],
    ['fe80::1%eth0/64', /CIDR/],
    ['::ffff:10.0.0.0/104', /IPv4/],
    ['', /CIDR/],
  ])('refuses %s', (text, reason) => {
    expect(cidrRefusal(text)).toMatch(reason)
    expect(() => parseCidr(text)).toThrow(reason)
  })

  it('covers the addresses it names, an IPv4-mapped address as the IPv4 address it carries', () => {
    const listed = ranges('10.0.0.0/8', 'fd00::/8', '::1/128')
    expect(rangeCovering('10.1.2.3', listed)?.text).toBe('10.0.0.0/8')
    expect(rangeCovering('::ffff:10.1.2.3', listed)?.text).toBe('10.0.0.0/8')
    expect(rangeCovering('fd12::1', listed)?.text).toBe('fd00::/8')
    expect(rangeCovering('::1', listed)?.text).toBe('::1/128')
    for (const address of ['11.0.0.1', '127.0.0.1', 'fe80::1', 'localhost', 'db.internal']) expect(rangeCovering(address, listed)).toBeNull()
  })
})

describe('the egress rule with private ranges', () => {
  const judge = (url: string, options: Parameters<typeof createNetworkEgressRule>[0]) => createNetworkEgressRule(options).evaluate({
    tool: 'web_fetch', effect: { kind: 'network', url: new URL(url) }, grants: { subjectsFor: () => [], patternsFor: () => [] },
  })

  it('reaches an address a range covers without asking, and asks for one it does not', () => {
    const privateRanges = ranges('10.0.0.0/8', '::1/128')
    expect(judge('http://10.0.0.5:8080/', { approved: null, privateRanges })).toEqual({ kind: 'allow' })
    expect(judge('http://[::1]:3000/', { approved: null, privateRanges })).toEqual({ kind: 'allow' })
    expect(judge('http://192.168.1.5/', { approved: null, privateRanges })).toMatchObject({ kind: 'ask', rule: 'network_egress' })
    expect(judge('http://10.0.0.5:8080/', { approved: null, privateRanges: [] })).toMatchObject({ kind: 'ask' })
  })

  it('still asks for a name that means this machine, which no range names', () => {
    expect(judge('http://localhost:3000/', { approved: null, privateRanges: ranges('127.0.0.0/8', '::1/128') })).toMatchObject({ kind: 'ask' })
  })

  it('keeps asking for the node\'s own listener whatever a range holds, at its own address, a loopback one, and any where it listens on every one', () => {
    const own = { host: '127.0.0.1', port: 4320 }
    expect(judge('http://127.0.0.1:4320/mcp', { approved: null, privateRanges: ranges('127.0.0.1/32'), listener: own })).toMatchObject({ kind: 'ask', rule: 'network_egress' })
    expect(judge('http://[::1]:4320/mcp', { approved: null, privateRanges: ranges('::1/128'), listener: own })).toMatchObject({ kind: 'ask' })
    expect(judge('http://[::ffff:127.0.0.1]:4320/mcp', { approved: null, privateRanges: ranges('127.0.0.0/8'), listener: own })).toMatchObject({ kind: 'ask' })
    expect(judge('http://127.0.0.1:3000/', { approved: null, privateRanges: ranges('127.0.0.1/32'), listener: own })).toEqual({ kind: 'allow' })
    const everywhere = { host: '0.0.0.0', port: 4320 }
    expect(judge('http://10.0.0.5:4320/mcp', { approved: null, privateRanges: ranges('10.0.0.0/8'), listener: everywhere })).toMatchObject({ kind: 'ask' })
    expect(judge('http://10.0.0.5:8080/', { approved: null, privateRanges: ranges('10.0.0.0/8'), listener: everywhere })).toEqual({ kind: 'allow' })
    expect(judge('http://10.0.0.5:4320/', { approved: null, privateRanges: ranges('10.0.0.0/8'), listener: own })).toEqual({ kind: 'allow' })
  })

  it('never lifts the approved list: an address in a range but off the list is refused', () => {
    expect(judge('http://10.0.0.5/', { approved: compileUrlPatterns(['api.example.test']), privateRanges: ranges('10.0.0.0/8') })).toMatchObject({ kind: 'deny' })
  })
})

describe('guardedFetch with private ranges', () => {
  const fetchFrom = (url: string, input: { approved?: ReturnType<typeof compileUrlPatterns> | null; privateRanges: ReturnType<typeof ranges>; listener?: NodeListener }) => guardedFetch({
    url: new URL(url), method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000),
    approved: input.approved ?? null, judge: async () => ({ kind: 'allowed' }), privateRanges: input.privateRanges,
    ...(input.listener === undefined ? {} : { listener: input.listener }),
  })

  it('reaches an address a range covers, which no approval cleared', async () => {
    expect(await (await fetchFrom(`http://127.0.0.1:${port}/`, { privateRanges: ranges('127.0.0.1/32') })).text()).toBe('arrived')
    await expect(fetchFrom(`http://127.0.0.1:${port}/`, { privateRanges: ranges('10.0.0.0/8') })).rejects.toThrow(/loopback/)
  })

  it('refuses the node\'s own listener on every hop, a name that resolves to it included, whatever a range holds', async () => {
    const listener = { host: '127.0.0.1', port }
    await expect(fetchFrom(`http://127.0.0.1:${port}/mcp`, { privateRanges: ranges('127.0.0.1/32'), listener })).rejects.toThrow(/loopback/)
    const approved = compileUrlPatterns([`*.localhost:${port}`])
    await expect(fetchFrom(`http://localhost:${port}/mcp`, { approved, privateRanges: ranges('127.0.0.0/8', '::1/128'), listener })).rejects.toThrow(/loopback/)
    expect(await (await fetchFrom(`http://127.0.0.1:${port}/`, { privateRanges: ranges('127.0.0.1/32'), listener: { host: '127.0.0.1', port: port + 1 } })).text()).toBe('arrived')
  })

  it('lets a wildcard list entry reach a host that resolves into the ranges alone', async () => {
    const approved = compileUrlPatterns([`*.localhost:${port}`])
    expect(await (await fetchFrom(`http://localhost:${port}/`, { approved, privateRanges: ranges('127.0.0.0/8', '::1/128') })).text()).toBe('arrived')
    await expect(fetchFrom(`http://localhost:${port}/`, { approved, privateRanges: ranges('10.0.0.0/8') })).rejects.toThrow(/loopback/)
  })
})

describe('check-url with private ranges', () => {
  it('says the range that clears an address', () => {
    const privateRanges = ranges('127.0.0.0/8')
    const rule = createNetworkEgressRule({ approved: null, privateRanges })
    expect(judgeUrl({ url: new URL('http://127.0.0.1:5432/'), rule, approved: null, privateRanges, workspaceList: [], approvals: [] })).toEqual({ verdict: 'approved', because: 'network.privateRanges entry 127.0.0.0/8' })
  })
})

describe('network.privateRanges, the setting', () => {
  it('is the workspace\'s own, else the node\'s, else none, naming where it came from, and its file takes CIDR alone', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    expect(resolveSettings(unset, loadConfig({}).workspaceDefaults)).toMatchObject({ network: { privateRanges: [] }, sources: { 'network.privateRanges': 'built-in' } })
    const node = loadConfig({ BUCKLE_NETWORK_PRIVATE_RANGES: '10.0.0.0/8, fd00::/8' }).workspaceDefaults
    expect(resolveSettings(unset, node)).toMatchObject({ network: { privateRanges: ['10.0.0.0/8', 'fd00::/8'] }, sources: { 'network.privateRanges': 'node' } })
    const own = WorkspaceSettingsSchema.parse({ version: 1, network: { privateRanges: ['192.168.1.0/24'] } })
    expect(resolveSettings(own, node)).toMatchObject({ network: { privateRanges: ['192.168.1.0/24'] }, sources: { 'network.privateRanges': 'workspace' } })
    for (const entry of ['localhost', '*.internal', '10.0.0.5/8']) expect(WorkspaceSettingsSchema.safeParse({ version: 1, network: { privateRanges: [entry] } }).success).toBe(false)
  })

  it('stops the node at a range it refuses, naming the variable', () => {
    expect(() => loadConfig({ BUCKLE_NETWORK_PRIVATE_RANGES: '10.0.0.0/8, db.internal' })).toThrow(/Invalid BUCKLE_NETWORK_PRIVATE_RANGES entry db\.internal: .*CIDR/)
  })

  it('is set with buckle workspace set, refused for anything but CIDR, and shown with its source', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'private-ranges-admin-credential', BUCKLE_SANDBOX: 'none' })
    let out = ''
    let err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().network

    expect((await buckle(['set', 'network.privateRanges', '10.0.0.0/8, fd00::/8'])).exitCode).toBe(0)
    expect(stored()).toEqual({ privateRanges: ['10.0.0.0/8', 'fd00::/8'] })
    for (const value of ['localhost', '*.internal', '10.0.0.5/8']) {
      expect((await buckle(['set', 'network.privateRanges', value])).exitCode).toBe(1)
    }
    expect(err).toContain('network.privateRanges')
    expect(stored()).toEqual({ privateRanges: ['10.0.0.0/8', 'fd00::/8'] })
    out = ''
    await buckle(['show'])
    expect(out).toMatch(/network\.privateRanges +10\.0\.0\.0\/8, fd00::\/8 +workspace/)
    expect((await buckle(['unset', 'network.privateRanges'])).exitCode).toBe(0)
    expect(stored()).toBeUndefined()
    await manager.close()
  })

  it('takes the node\'s default with buckle settings set network-private-ranges, CIDR alone', async () => {
    const root = scratch()
    const file = join(root, 'buckle.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${join(root, 'state')}\n`, { mode: 0o600 })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const settings = (argv: string[]) => settingsCommand({ argv, environment: {}, environmentFile: file, cwd: root, home: root })
    expect((await settings(['set', 'network-private-ranges', 'localhost'])).exitCode).toBe(1)
    expect((await settings(['set', 'network-private-ranges', '10.0.0.0/8, 127.0.0.1/32'])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain('BUCKLE_NETWORK_PRIVATE_RANGES=10.0.0.0/8,127.0.0.1/32\n')
  })
})

describe('a workspace with private ranges', () => {
  const configWith = (environment: Record<string, string>) => configFromEnvironment({
    BUCKLE_AUTH_TOKEN: 'agent', BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-ranges-state-')), BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-ranges-ws-')), BUCKLE_ALLOW_SHELL: 'false', ...environment,
  })
  async function runtimeOf(config: ReturnType<typeof configWith>): Promise<CoreRuntime> {
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    return runtime
  }
  const runtimeWith = (environment: Record<string, string>) => runtimeOf(configWith(environment))
  const fetchLocal = (runtime: CoreRuntime): Promise<InvokeResponse> => runtime.invoke({ request: { requestId: `fetch-${randomUUID()}`, tool: 'web_fetch', args: { url: `http://127.0.0.1:${port}/` }, approvalTokens: [] }, sessionId: 'fetcher' })

  it('fetches an address the node\'s ranges cover without asking, and asks without them', async () => {
    expect(await fetchLocal(await runtimeWith({ BUCKLE_NETWORK_PRIVATE_RANGES: '127.0.0.1/32' }))).toMatchObject({ outcome: 'ok', output: { body: 'arrived' } })
    expect(await fetchLocal(await runtimeWith({}))).toMatchObject({ outcome: 'approval_required' })
  })

  it('asks before web_fetch reaches the node\'s own serve listener, though a range covers its address', async () => {
    const runtime = await runtimeWith({ BUCKLE_NETWORK_PRIVATE_RANGES: '127.0.0.1/32', BUCKLE_HOST: '127.0.0.1', BUCKLE_PORT: String(port) })
    const own = await runtime.invoke({ request: { requestId: `fetch-${randomUUID()}`, tool: 'web_fetch', args: { url: `http://127.0.0.1:${port}/mcp`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, approvalTokens: [] }, sessionId: 'fetcher' })
    expect(own).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'network_egress', subject: `127.0.0.1:${port}` }] })
  })

  it('takes a range the workspace sets while it runs up at the next call, in the rule and in web_fetch alike', async () => {
    const config = configWith({})
    const runtime = await runtimeOf(config)
    const settings = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory!, config.workspaceId) })
    // A first change taken up alone, so the next one differs from what is in force by its ranges alone.
    await settings.update(current => ({ ...current, approval: { ...current.approval, forms: false } }))
    expect(await fetchLocal(runtime)).toMatchObject({ outcome: 'approval_required' })
    await settings.update(current => ({ ...current, network: { privateRanges: ['127.0.0.0/8'] } }))
    expect(await fetchLocal(runtime)).toMatchObject({ outcome: 'ok', output: { body: 'arrived' } })
  })
})
