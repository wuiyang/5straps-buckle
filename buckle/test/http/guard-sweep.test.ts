import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { generateSigningKey, signingKeyFromPem, signRequest, type SignedRequestPurpose } from '@5straps/protocol/signed-request'
import { keysCommand } from '../../cli/keys.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Review M2 of B15-B17: the guard property across the whole route table, not by sample. Every route
// the built layers serve, with every method, under every kind of credential a caller can hold. MCP
// over HTTP takes the agent credential, so the agent rows cover it. Review M3 of B18-B19: exact
// statuses, and each workspace's agent credential held against the other workspace's paths.

const NODE_AGENT = 'sweep-node-agent-token-fixture-only'
const NODE_ADMIN = 'sweep-node-admin-token-fixture-only'
const GRANT = { id: randomUUID(), token: 'sweep-node-workbench-grant-fixture-only', projectId: 'project', chatId: 'chat', allowShell: false }
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
/** The child's agent token is minted when it is registered (D83 (3)), so it is filled in then. */
const CREDENTIALS: Record<'none' | 'node agent' | 'child agent' | 'node admin' | 'workbench grant', string | undefined> = { none: undefined, 'node agent': NODE_AGENT, 'child agent': undefined, 'node admin': NODE_ADMIN, 'workbench grant': GRANT.token }
const OPEN_PATHS = ['/health', '/health/ready']
/** Paths no route file claims (review L10 of B20-B22): only the router's own 404 may answer them. */
const OFF_TABLE = ['/', '/debug', '/api/debug', '/v2/invoke', '/_nitro/tasks', '/setupx/status', '/healthz', '/health/ready/x', '/mcp/extra', '/workspaces']
type Credential = keyof typeof CREDENTIALS
type Face = 'setup' | 'agent' | 'workbench'
type Workspace = 'node' | 'child'

/** The one credential each face accepts per workspace; the node's admin credential is every workspace's (D83); the workbench grant was minted on the node. */
const ACCEPTS: Record<Face, Record<Workspace, Credential | undefined>> = {
  setup: { node: 'node admin', child: 'node admin' },
  agent: { node: 'node agent', child: 'child agent' },
  workbench: { node: 'workbench grant', child: undefined },
}

interface Probe { path: string; method: string; credential: Credential; status: number; audited: boolean; served: boolean }

let buckle: BuckleHttp
let probes: Probe[]
let offTable: Probe[]
let signedProbes: SignedProbe[]
let internalsBefore: Internals

/** A person's enrolled key, node-wide for both purposes, and one nobody enrolled. */
const enrolled = generateSigningKey()
const stranger = generateSigningKey()
type Signer = 'setup in session' | 'setup without session' | 'approval' | 'stranger setup' | 'stranger approval'
interface SignedProbe { path: string; method: string; signer: Signer; status: number; served: boolean }

beforeAll(async () => {
  const { root, environment } = nodeEnvironment('buckle-sweep-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: NODE_ADMIN, BUCKLE_PACKS: 'fs' })
  buckle = await createBuckleHttp({ environment })
  // Before any request, so a wrapper something installs on its first call is not in the baseline (review item 21).
  // h3 builds its own dispatcher on the first handler() call: one on a path outside the table runs no route,
  // util or request hook, so the baseline holds h3's dispatcher and nothing else.
  ;(buckle.nitroApp.h3 as unknown as { handler: (event: unknown) => unknown }).handler({ req: { method: 'GET' }, url: new URL('/sweep-baseline', 'http://127.0.0.1'), context: {} })
  internalsBefore = internals()
  mkdirSync(join(root, 'child'))
  const registered = await buckle.request('/setup/workspaces', { method: 'POST', headers: bearer(NODE_ADMIN), body: JSON.stringify({ id: 'child', name: 'child', dir: join(root, 'child') }) })
  expect(registered.status).toBe(201)
  CREDENTIALS['child agent'] = (await registered.json() as { token: { token: string } }).token.token
  expect((await buckle.request('/setup/workbenches', { method: 'POST', headers: bearer(NODE_ADMIN), body: JSON.stringify(GRANT) })).status).toBe(200)
  probes = await sweep(concretePaths())
  offTable = await sweep(new Map(OFF_TABLE.map(path => [path, new Set<string>()])))
  signedProbes = await signedSweep()
}, 360_000)
afterAll(async () => { await buckle?.close() })

function bearer(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * Each route as concrete paths, a twin under the node's alias and under the child, parameters filled,
 * with the methods its route files serve there ('ALL' for a file without a method suffix).
 */
function concretePaths(): Map<string, Set<string>> {
  const fill = (path: string) => path
    .replace(/(\/v1\/workbenches\/):workbenchId/, `$1${GRANT.id}`)
    .replace(/:workbenchId|:terminalId/g, () => randomUUID())
    .replace(/:workspaceId/g, 'ghost')
    .replace(/:(?:skillId|grantId|checkpointId|tokenId|sessionId)/g, 'nope')
    .replace(/\*\*$/, 'sweep-probe')
  const served = new Map<string, Set<string>>()
  for (const route of buckle.routes()) {
    const twins = route.path.startsWith('/workspaces/:id/') ? ['default', 'child'].map(id => route.path.replace(':id', id)) : [route.path]
    for (const path of twins.map(fill)) served.set(path, (served.get(path) ?? new Set()).add(route.method))
  }
  return served
}

/** Whether a route file at the path serves the method itself; HEAD is served wherever GET is (20.head.ts). */
function serves(methods: Set<string>, method: string): boolean {
  return methods.has('ALL') || methods.has(method) || method === 'HEAD' && methods.has('GET')
}

async function sweep(paths: Map<string, Set<string>>): Promise<Probe[]> {
  const results: Probe[] = []
  for (const [path, methods] of paths) {
    for (const method of METHODS) {
      for (const [credential, token] of Object.entries(CREDENTIALS) as Array<[Credential, string | undefined]>) {
        const before = newestAudit()
        const response = await buckle.request(path, { method, headers: { 'content-type': 'application/json', ...bearer(token) } })
        await response.body?.cancel()
        results.push({ path, method, credential, status: response.status, audited: newestAudit() !== before, served: serves(methods, method) })
      }
    }
  }
  return results
}

/**
 * The admin paths again under signed requests (review L8 of B23-B25): a node-wide key enrolled for both
 * purposes, as a setup request naming its open session on that workspace, one naming none, and an
 * approval request; and a key nobody enrolled. Each request is signed for its own method, path and
 * body, so only the scope and the route's kind of access decide.
 */
async function signedSweep(): Promise<SignedProbe[]> {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect((await keysCommand({ config: buckle.config, argv: ['enroll', enrolled.publicKey, '--purpose', 'both', '--workspace', 'node'] })).exitCode).toBe(0)
  vi.restoreAllMocks()
  const nodeKey = (await buckle.services.getNodeSigner()).keyId
  const sign = (input: { key: typeof enrolled; purpose: SignedRequestPurpose; workspace: string; method: string; path: string; session?: string }) => signRequest({
    key: signingKeyFromPem(input.key.privateKeyPem), purpose: input.purpose, node: buckle.config.serverId, nodeKey, workspace: input.workspace,
    method: input.method, path: input.path, body: '', ...(input.session ? { session: input.session } : {}),
  })
  const sessions = new Map<string, string>()
  for (const workspace of ['default', 'child']) {
    const path = workspace === 'default' ? '/setup/sessions' : `/workspaces/${workspace}/setup/sessions`
    const opened = await buckle.request(path, { method: 'POST', headers: { authorization: sign({ key: enrolled, purpose: 'buckle-setup', workspace, method: 'POST', path }) } })
    expect(opened.status).toBe(201)
    sessions.set(workspace, (await opened.json() as { session: { id: string } }).session.id)
  }
  const results: SignedProbe[] = []
  for (const [path, methods] of concretePaths()) {
    if (!isSetup(path)) continue
    const workspace = path.startsWith('/workspaces/child/') ? 'child' : 'default'
    for (const method of METHODS) {
      const signers: Array<[Signer, string]> = [
        ['setup in session', sign({ key: enrolled, purpose: 'buckle-setup', workspace, method, path, session: sessions.get(workspace)! })],
        ['setup without session', sign({ key: enrolled, purpose: 'buckle-setup', workspace, method, path })],
        ['approval', sign({ key: enrolled, purpose: 'buckle-approval', workspace, method, path })],
        ['stranger setup', sign({ key: stranger, purpose: 'buckle-setup', workspace, method, path, session: sessions.get(workspace)! })],
        ['stranger approval', sign({ key: stranger, purpose: 'buckle-approval', workspace, method, path })],
      ]
      for (const [signer, authorization] of signers) {
        const response = await buckle.request(path, { method, headers: { authorization } })
        await response.body?.cancel()
        results.push({ path, method, signer, status: response.status, served: serves(methods, method) })
      }
    }
  }
  return results
}

/**
 * What a route could patch at runtime, by identity (review L7 of B23-B25, item 21 of the proof-of-possession
 * fixes): the h3 app's own functions, every hook, and each route the router matches for every path and
 * method of the table, its data object and its handler. The compiled router answers from module data, so
 * route tables on the app stay empty and prove nothing; this asks the router itself.
 */
type Internals = { app: Record<string, unknown>; config: Record<string, unknown>; methods: Record<string, unknown>; hooks: Record<string, unknown[]>; routes: Map<string, { data: object; handler: unknown }> }
function internals(): Internals {
  const app = buckle.nitroApp.h3 as unknown as Record<string, unknown>
  const hooks = (buckle.nitroApp.hooks as unknown as { _hooks?: Record<string, unknown[]> })._hooks ?? {}
  return {
    app: Object.fromEntries(Object.entries(app).filter(([, value]) => typeof value === 'function')),
    // Review L11 of the second re-review: the request, response and error hooks h3 calls from the app's config,
    // and each method the app runs as it resolves it now (its own, or its classes'), so a wrapper on either shows.
    config: Object.fromEntries(Object.entries(app.config as Record<string, unknown>).filter(([, value]) => typeof value === 'function')),
    methods: Object.fromEntries(methodNames(app).map(name => [name, app[name]])),
    hooks: Object.fromEntries(Object.entries(hooks).map(([name, list]) => [name, [...list]])),
    routes: matchedRoutes(),
  }
}

/** Every method name the app's classes define, as the app resolves them. */
function methodNames(app: object): string[] {
  const names = new Set<string>()
  for (let prototype = Object.getPrototypeOf(app) as object | null; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype) as object | null) {
    for (const name of Object.getOwnPropertyNames(prototype)) if (name !== 'constructor') names.add(name)
  }
  return [...names]
}

/** The paths the route snapshot asks about, filled once, since concretePaths() fills some parameters at random. */
let snapshotPaths: string[] | undefined

/** The route the router answers each path and method with. */
function matchedRoutes(): Map<string, { data: object; handler: unknown }> {
  const findRoute = (buckle.nitroApp.h3 as unknown as { '~findRoute': (event: unknown) => { data: { handler: unknown } } | undefined })['~findRoute']
  const matched = new Map<string, { data: object; handler: unknown }>()
  for (const path of snapshotPaths ??= [...concretePaths().keys(), ...OFF_TABLE]) {
    for (const method of METHODS) {
      const match = findRoute({ req: { method }, url: new URL(path, 'http://127.0.0.1'), context: {} })
      if (match) matched.set(`${method} ${path}`, { data: match.data, handler: match.data.handler })
    }
  }
  return matched
}

// Every refusal before authentication is recorded on the node's log, the twins' included.
function newestAudit(): string | undefined {
  return buckle.runtime.actions.read(1)[0]?.auditId
}

function isSetup(path: string): boolean {
  return /^\/(?:workspaces\/[^/]+\/)?setup\//.test(path)
}

function isWorkbench(path: string): boolean {
  return /^\/(?:workspaces\/[^/]+\/)?v1\/workbenches\//.test(path)
}

function workspaceOf(path: string): Workspace {
  return path.startsWith('/workspaces/child/') ? 'child' : 'node'
}

/**
 * The face of the route that answers: the path's own route file, or, for a method no file there
 * serves, its catch-all (the /setup one on admin paths, the agent's /v1 or /workspaces/[id] one
 * elsewhere, workbench paths included).
 */
function faceOf(probe: Probe): Face {
  if (isSetup(probe.path)) return 'setup'
  return probe.served && isWorkbench(probe.path) ? 'workbench' : 'agent'
}

const accepted = (probe: Probe) => ACCEPTS[faceOf(probe)][workspaceOf(probe.path)] === probe.credential
const guarded = (probe: Probe) => !OPEN_PATHS.includes(probe.path)
const succeeded = (probe: Probe) => probe.status >= 200 && probe.status < 300
const describeProbe = (probe: Probe) => `${probe.method} ${probe.path} as ${probe.credential}: ${probe.status}`

describe('the guard sweep over every route, method and credential', () => {
  it('covers the whole route table', () => {
    expect(new Set(probes.map(probe => probe.path)).size).toBeGreaterThan(100)
    expect(probes.length).toBe(new Set(probes.map(probe => probe.path)).size * METHODS.length * Object.keys(CREDENTIALS).length)
  })

  it('answers 401, exactly, to every credential the answering face does not accept, on every path and method but /health and /health/ready', () => {
    const refused = probes.filter(probe => guarded(probe) && !accepted(probe))
    expect(refused.length).toBeGreaterThan(3_000)
    expect(refused.filter(probe => probe.status !== 401).map(describeProbe)).toEqual([])
  })

  it('answers a method no route file serves from the catch-all: 404 to its own credential only, a workbench path\'s agent credential included', () => {
    const caught = probes.filter(probe => guarded(probe) && !probe.served && accepted(probe))
    expect(caught.filter(probe => probe.status !== 404).map(describeProbe)).toEqual([])
    // The documented v1 catch-all 404: a wrong method on a workbench path with that workspace's agent credential.
    const workbench = caught.filter(probe => isWorkbench(probe.path))
    expect(workbench.length).toBeGreaterThan(100)
    expect(workbench.every(probe => probe.credential === ACCEPTS.agent[workspaceOf(probe.path)])).toBe(true)
  })

  it('refuses each workspace\'s agent credential on the other\'s paths: the node agent on the child\'s, the child agent on the node\'s /v1 and /mcp', () => {
    const nodeOnChild = probes.filter(probe => probe.credential === 'node agent' && workspaceOf(probe.path) === 'child')
    const childOnNode = probes.filter(probe => probe.credential === 'child agent' && /^\/(?:v1\/|mcp$|workspaces\/default\/)/.test(probe.path))
    expect(nodeOnChild.some(probe => probe.path.startsWith('/workspaces/child/v1/'))).toBe(true)
    expect(childOnNode.some(probe => probe.path.startsWith('/v1/'))).toBe(true)
    expect([...nodeOnChild, ...childOnNode].filter(probe => probe.status !== 401).map(describeProbe)).toEqual([])
  })

  it('answers nothing below 400 without a credential but /health and /health/ready', () => {
    const open = probes.filter(probe => probe.credential === 'none' && probe.status < 400 && guarded(probe))
    expect(open.map(describeProbe)).toEqual([])
  })

  it('answers a /setup path 2xx to its own admin credential only', () => {
    const leaks = probes.filter(probe => isSetup(probe.path) && succeeded(probe) && !accepted(probe))
    expect(leaks.map(describeProbe)).toEqual([])
    expect(probes.some(probe => isSetup(probe.path) && succeeded(probe))).toBe(true)
  })

  it('never answers /v1 or /mcp 2xx to an admin credential, and a workbench path 2xx only to its own grant', () => {
    const agentPaths = probes.filter(probe => !isSetup(probe.path) && guarded(probe))
    const adminLeaks = agentPaths.filter(probe => succeeded(probe) && probe.credential.endsWith('admin'))
    expect(adminLeaks.map(describeProbe)).toEqual([])
    const grantLeaks = agentPaths.filter(probe => succeeded(probe) && (probe.credential === 'workbench grant') !== isWorkbench(probe.path))
    expect(grantLeaks.map(describeProbe)).toEqual([])
    const foreignGrant = probes.filter(probe => isWorkbench(probe.path) && probe.path.startsWith('/workspaces/child/') && succeeded(probe))
    expect(foreignGrant.map(describeProbe)).toEqual([])
    expect(probes.some(probe => isWorkbench(probe.path) && probe.credential === 'workbench grant' && succeeded(probe))).toBe(true)
  })

  it('answers 404 to every method and credential on a path outside the route table, and serves nothing there (review L10 of B20-B22)', () => {
    const patterns = buckle.routes().map(route => new RegExp(`^${route.path.replace(/:\w+/g, '[^/]+').replace(/\*\*$/, '.*')}$`))
    expect(OFF_TABLE.filter(path => patterns.some(pattern => pattern.test(path)))).toEqual([])
    expect(offTable.length).toBe(OFF_TABLE.length * METHODS.length * Object.keys(CREDENTIALS).length)
    expect(offTable.filter(probe => probe.status !== 404).map(describeProbe)).toEqual([])
  })

  it('leaves the app\'s handler and dispatch, every route the router matches and every hook as they were before the first request (review L7 of B23-B25, item 21)', () => {
    const after = internals()
    expect(Object.keys(internalsBefore.app)).toEqual(expect.arrayContaining(['fetch', 'handler', '~dispatch', '~findRoute']))
    expect(Object.keys(after.app).sort()).toEqual(Object.keys(internalsBefore.app).sort())
    for (const [name, value] of Object.entries(internalsBefore.app)) expect(after.app[name], name).toBe(value)
    expect(Object.keys(internalsBefore.config)).toEqual(expect.arrayContaining(['onRequest', 'onError']))
    expect(internalsBefore.methods).toMatchObject({ fetch: expect.any(Function), handler: expect.any(Function) })
    for (const part of ['config', 'methods'] as const) {
      expect(Object.keys(after[part]).sort(), part).toEqual(Object.keys(internalsBefore[part]).sort())
      for (const [name, value] of Object.entries(internalsBefore[part])) expect(after[part][name], `${part}.${name}`).toBe(value)
    }
    expect(internalsBefore.routes.size).toBeGreaterThan(500)
    expect([...after.routes.keys()]).toEqual([...internalsBefore.routes.keys()])
    const moved = [...internalsBefore.routes].filter(([key, route]) => after.routes.get(key)?.data !== route.data || after.routes.get(key)?.handler !== route.handler).map(([key]) => key)
    expect(moved).toEqual([])
    expect(Object.keys(internalsBefore.hooks).length).toBeGreaterThan(0)
    expect(Object.keys(after.hooks).sort()).toEqual(Object.keys(internalsBefore.hooks).sort())
    for (const [name, list] of Object.entries(internalsBefore.hooks)) {
      expect(after.hooks[name]!.length, name).toBe(list.length)
      list.forEach((hook, index) => expect(after.hooks[name]![index], name).toBe(hook))
    }
  })

  it('refuses to swap a matched route\'s handler in place: the router hands out its data frozen (review item 21)', () => {
    const key = 'PUT /setup/policy'
    const route = matchedRoutes().get(key)!
    expect(Object.isFrozen(route.data), key).toBe(true)
    expect(() => { (route.data as { handler: unknown }).handler = () => 'swapped' }).toThrow(TypeError)
    expect(() => Object.assign(route.data, { handler: () => 'swapped' })).toThrow(TypeError)
    expect(matchedRoutes().get(key)!.handler).toBe(route.handler)
  })

  // Review L11 of the second proof-of-possession re-review: a wrapper on the app's config hooks or on the shared h3
  // prototype passed every check before, while /setup/policy answered 200 with no credential.
  it('refuses a wrapper on the app\'s request hook: its config is frozen and fixed on the app', async () => {
    const app = buckle.nitroApp.h3 as unknown as { config: Record<string, unknown> }
    let ran = false
    const wrapped = () => { ran = true }
    expect(() => { app.config.onRequest = wrapped }).toThrow(TypeError)
    expect(() => { (app as { config: object }).config = { onRequest: wrapped } }).toThrow(TypeError)
    const response = await buckle.request('/setup/policy', { method: 'GET' })
    await response.body?.cancel()
    expect(response.status).toBe(401)
    expect(ran).toBe(false)
  })

  it('never runs a wrapper put on the shared h3 prototype: the app runs the methods it was locked with', async () => {
    const app = buckle.nitroApp.h3 as unknown as Record<string, unknown>
    const prototype = Object.getPrototypeOf(app) as Record<string, (...args: unknown[]) => unknown>
    const original = prototype['~request']!
    let ran = false
    // A wrapper that would hand every request the node's admin credential.
    prototype['~request'] = function (this: unknown, ...args: unknown[]) {
      ran = true
      const [request, ...rest] = args as [Request, ...unknown[]]
      const headers = new Headers(request.headers)
      headers.set('authorization', `Bearer ${NODE_ADMIN}`)
      return original.call(this, new Request(request, { headers }), ...rest)
    }
    try {
      const response = await buckle.request('/setup/policy', { method: 'GET' })
      await response.body?.cancel()
      expect(response.status).toBe(401)
      expect(ran).toBe(false)
    } finally {
      prototype['~request'] = original
    }
  })

  it('admits a signed request only for its purpose: setup naming an open session on a change, approval on the approval routes, a session open without one; a key nobody enrolled nowhere (review L8 of B23-B25)', () => {
    expect(new Set(signedProbes.map(probe => probe.path)).size).toBeGreaterThan(50)
    // The guard answers a bare 401; anything else means the request got past it.
    const admitted = signedProbes.filter(probe => probe.status !== 401)
    const approvalAccess = (probe: SignedProbe) => (probe.method === 'POST' && /\/setup\/approvals(?:\/withdraw)?$/.test(probe.path)) || (['GET', 'HEAD'].includes(probe.method) && /\/setup\/approvals\/challenges$/.test(probe.path))
    const sessionOpen = (probe: SignedProbe) => probe.method === 'POST' && /\/setup\/sessions$/.test(probe.path)
    const change = (probe: SignedProbe) => !['GET', 'HEAD'].includes(probe.method)
    const wrong = admitted.filter((probe) => {
      switch (probe.signer) {
        case 'approval': return !approvalAccess(probe)
        case 'setup without session': return !sessionOpen(probe)
        case 'setup in session': return !change(probe) || approvalAccess(probe) || sessionOpen(probe)
        default: return true
      }
    })
    expect(wrong.map(probe => `${probe.method} ${probe.path} as ${probe.signer}: ${probe.status}`)).toEqual([])
    expect(admitted.filter(probe => probe.signer === 'setup in session').length).toBeGreaterThan(100)
    expect(admitted.filter(probe => probe.signer === 'approval').length).toBeGreaterThan(5)
    expect(signedProbes.filter(probe => probe.signer.startsWith('stranger')).length).toBeGreaterThan(500)
  })

  it('audits every refusal of a /setup path', () => {
    const unaudited = probes.filter(probe => isSetup(probe.path) && [401, 403].includes(probe.status) && !probe.audited)
    expect(unaudited.map(describeProbe)).toEqual([])
    expect(probes.filter(probe => isSetup(probe.path) && probe.status === 401).length).toBeGreaterThan(1_000)
  })
})

describe('the admin layer with its experimental flag off (owner decision D8)', () => {
  it('answers every admin route 404, as the router answers an unmatched path, to every method and credential, admin included, and audits nothing', async () => {
    const { root, environment } = nodeEnvironment('buckle-sweep-off-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ADMIN_TOKEN: NODE_ADMIN, BUCKLE_PACKS: 'fs' })
    // A second copy of the build, so the swept node above keeps its app.
    const off = await createBuckleHttp({ environment, instance: 2 })
    let closing: Promise<void> | undefined
    try {
      mkdirSync(join(root, 'child'))
      await (await off.services.getWorkspaces()).create({ id: 'child', name: 'child', dir: join(root, 'child'), policy: emptyWorkspacePolicy() })
      const unmatched = await off.request('/sweep-off-table', { headers: bearer(NODE_ADMIN) })
      const expected = { status: 404, type: unmatched.headers.get('content-type'), body: await unmatched.text() }
      expect(expected.status).toBe(404)
      const before = off.runtime.actions.read(1)[0]?.auditId
      const paths = [...concretePaths().keys()].filter(isSetup)
      expect(paths.length).toBeGreaterThan(50)
      const answered: string[] = []
      for (const path of paths) {
        for (const method of METHODS) {
          for (const [credential, token] of Object.entries(CREDENTIALS)) {
            const response = await off.request(path, { method, headers: { 'content-type': 'application/json', ...bearer(token) } })
            const got = { status: response.status, type: response.headers.get('content-type'), body: method === 'HEAD' ? expected.body : await response.text() }
            if (JSON.stringify(got) !== JSON.stringify(expected)) answered.push(`${method} ${path} as ${credential}: ${got.status}`)
          }
        }
      }
      expect(answered).toEqual([])
      expect(off.runtime.actions.read(1)[0]?.auditId).toBe(before)
      // The agent's face still serves.
      expect((await off.request('/v1/manifest', { headers: bearer(NODE_AGENT) })).status).toBe(200)
      // A closing node answers an admin path as an unmatched one too, not 503 (review L9 of B23-B25).
      const held = Promise.withResolvers<void>()
      off.common.owner.onClose('waiters', 'held by the sweep', () => held.promise)
      closing = off.close()
      const during = await off.request('/setup/status', { headers: bearer(NODE_ADMIN) })
      const unmatchedDuring = await off.request('/sweep-off-table', { headers: bearer(NODE_ADMIN) })
      const got = { status: during.status, type: during.headers.get('content-type'), body: await during.text() }
      expect((await off.request('/health/ready')).status).toBe(503)
      held.resolve()
      expect(got).toEqual({ status: unmatchedDuring.status, type: unmatchedDuring.headers.get('content-type'), body: await unmatchedDuring.text() })
      expect(got.status).toBe(404)
    } finally {
      await (closing ?? off.close())
    }
  }, 120_000)
})


describe('a node with the flag on and no BUCKLE_ADMIN_TOKEN (review item 23 of the proof-of-possession fixes)', () => {
  it('answers its node-level admin paths as an unmatched path while it closes, as when ready, never 503', async () => {
    const { environment } = nodeEnvironment('buckle-sweep-no-token-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_PACKS: 'fs' })
    const node = await createBuckleHttp({ environment, instance: 2 })
    let closing: Promise<void> | undefined
    const answer = async (response: Response) => ({ status: response.status, type: response.headers.get('content-type'), body: await response.text() })
    const probe = () => Promise.all([
      node.request('/setup/status', { headers: bearer(NODE_ADMIN) }),
      node.request('/setup/policy', { method: 'PUT', headers: { ...bearer(NODE_ADMIN), 'content-type': 'application/json' }, body: '{}' }),
      node.request('/setup/workspaces', { method: 'POST', headers: { ...bearer(NODE_ADMIN), 'content-type': 'application/json' }, body: '{}' }),
    ].map(async response => answer(await response)))
    try {
      const unmatched = await answer(await node.request('/sweep-no-token-table', { headers: bearer(NODE_ADMIN) }))
      expect(unmatched.status).toBe(404)
      expect(await probe()).toEqual([unmatched, unmatched, unmatched])
      const held = Promise.withResolvers<void>()
      node.common.owner.onClose('waiters', 'held by the sweep', () => held.promise)
      closing = node.close()
      const during = await probe()
      const unmatchedDuring = await answer(await node.request('/sweep-no-token-table', { headers: bearer(NODE_ADMIN) }))
      expect((await node.request('/health/ready')).status).toBe(503)
      held.resolve()
      expect(during).toEqual([unmatchedDuring, unmatchedDuring, unmatchedDuring])
      expect(unmatchedDuring.status).toBe(404)
    } finally {
      await (closing ?? node.close())
    }
  })
})
