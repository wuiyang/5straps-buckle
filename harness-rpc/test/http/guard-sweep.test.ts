import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Review M2 of B15-B17: the guard property across the whole route table, not by sample. Every route
// the built layers serve, with every method, under every kind of credential a caller can hold. MCP
// over HTTP takes the agent credential, so the agent rows cover it. Review M3 of B18-B19: exact
// statuses, and each workspace's agent credential held against the other workspace's paths.

const NODE_AGENT = 'sweep-node-agent-token-fixture-only'
const NODE_ADMIN = 'sweep-node-admin-token-fixture-only'
const CHILD_AGENT = 'sweep-child-agent-token-fixture-only'
const CHILD_ADMIN = 'sweep-child-admin-token-fixture-only'
const GRANT = { id: randomUUID(), token: 'sweep-node-workbench-grant-fixture-only', projectId: 'project', chatId: 'chat', allowShell: false }
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const CREDENTIALS = { none: undefined, 'node agent': NODE_AGENT, 'child agent': CHILD_AGENT, 'node admin': NODE_ADMIN, 'child admin': CHILD_ADMIN, 'workbench grant': GRANT.token } as const
const OPEN_PATHS = ['/health', '/health/ready']
type Credential = keyof typeof CREDENTIALS
type Face = 'setup' | 'agent' | 'workbench'
type Workspace = 'node' | 'child'

/** The one credential each face accepts per workspace; the workbench grant was minted on the node. */
const ACCEPTS: Record<Face, Record<Workspace, Credential | undefined>> = {
  setup: { node: 'node admin', child: 'child admin' },
  agent: { node: 'node agent', child: 'child agent' },
  workbench: { node: 'workbench grant', child: undefined },
}

interface Probe { path: string; method: string; credential: Credential; status: number; audited: boolean; served: boolean }

let buckle: BuckleHttp
let probes: Probe[]

beforeAll(async () => {
  const { root, environment } = nodeEnvironment('buckle-sweep-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ADMIN_TOKEN: NODE_ADMIN, BUCKLE_PACKS: 'fs' })
  buckle = await createBuckleHttp({ environment })
  mkdirSync(join(root, 'child'))
  const registered = await buckle.request('/setup/workspaces', { method: 'POST', headers: bearer(NODE_ADMIN), body: JSON.stringify({ id: 'child', name: 'child', root: join(root, 'child'), authToken: CHILD_AGENT, adminToken: CHILD_ADMIN }) })
  expect(registered.status).toBe(201)
  expect((await buckle.request('/setup/workbenches', { method: 'POST', headers: bearer(NODE_ADMIN), body: JSON.stringify(GRANT) })).status).toBe(200)
  probes = await sweep()
}, 240_000)
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
    .replace(/:(?:skillId|grantId|checkpointId|tokenId)/g, 'nope')
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

async function sweep(): Promise<Probe[]> {
  const results: Probe[] = []
  for (const [path, methods] of concretePaths()) {
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

  it('audits every refusal of a /setup path', () => {
    const unaudited = probes.filter(probe => isSetup(probe.path) && [401, 403].includes(probe.status) && !probe.audited)
    expect(unaudited.map(describeProbe)).toEqual([])
    expect(probes.filter(probe => isSetup(probe.path) && probe.status === 401).length).toBeGreaterThan(1_000)
  })
})
