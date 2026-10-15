import { generateSigningKey, signingKeyFromPem, signRequest, type SignedRequestPurpose } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keysCommand } from '../../cli/keys.js'
import { enrollEarlierKey } from '../support/earlier-keys.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// B24, approval-proofs.md (Setup activity; Protocol gates): a person's key opens a setup session with
// a signed request, and each signed setup change names it and refreshes it. Forged, replayed or
// foreign requests refresh nothing; completion and revocation close it at once, and no replay undoes
// that. The admin credential still needs no session.

const ADMIN = 'setup-sessions-admin-token'
const nodes: BuckleHttp[] = []
/** Each node's signing key fingerprint, which a request names (owner decision D11). */
const nodeKeys = new Map<BuckleHttp, string>()
afterEach(async () => { vi.restoreAllMocks(); for (const node of nodes.splice(0)) await node.close() })

const owner = generateSigningKey()
const colleague = generateSigningKey()
const stranger = generateSigningKey()
const policy = JSON.stringify({ version: 1, commands: { allow: [], deny: ['rm *'] }, network: { allow: [] }, mount: null, updatedAt: null })

async function node(): Promise<BuckleHttp> {
  const { environment } = nodeEnvironment('buckle-setup-sessions-', { BUCKLE_AUTH_TOKEN: 'setup-sessions-agent-token', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  for (const key of [owner, colleague]) await enrollEarlierKey(started.config, key.publicKey)
  nodeKeys.set(started, (await started.services.getNodeSigner()).keyId)
  return started
}

interface Call { key?: typeof owner; purpose?: SignedRequestPurpose; method?: string; path?: string; body?: string; session?: string }

function signed(buckle: BuckleHttp, call: Call = {}): { authorization: string; call: Required<Pick<Call, 'method' | 'path' | 'body'>> } {
  const method = call.method ?? 'PUT'
  const path = call.path ?? buckle.setup('policy')
  const body = call.body ?? policy
  const authorization = signRequest({ key: signingKeyFromPem((call.key ?? owner).privateKeyPem), purpose: call.purpose ?? 'buckle-setup', node: buckle.config.serverId, nodeKey: nodeKeys.get(buckle)!, workspace: buckle.runtime.workspaceId, method, path, body, ...(call.session ? { session: call.session } : {}) })
  return { authorization, call: { method, path, body } }
}

function send(buckle: BuckleHttp, request: ReturnType<typeof signed>): Promise<Response> {
  const { method, path, body } = request.call
  return buckle.request(path, { method, headers: { authorization: request.authorization, 'content-type': 'application/json' }, ...(body ? { body } : {}) })
}

async function open(buckle: BuckleHttp, key = owner): Promise<string> {
  const response = await send(buckle, signed(buckle, { key, method: 'POST', path: buckle.setup('sessions'), body: '' }))
  expect(response.status).toBe(201)
  const { session } = await response.json() as { session: { id: string; idleExpiresAt: string; lastActivityAt: string } }
  expect(Date.parse(session.idleExpiresAt) - Date.parse(session.lastActivityAt)).toBe(10 * 60_000)
  return session.id
}

async function lastActivity(buckle: BuckleHttp, id: string): Promise<string | undefined> {
  return (await buckle.services.getSetupSessions()).list().find(session => session.id === id)?.lastActivityAt
}

function refusals(buckle: BuckleHttp): Array<string | undefined> {
  return buckle.nodeActions.read(200).filter(entry => entry.tool === 'setup_signed_request_refused').map(entry => entry.detail)
}

describe('a setup session (B24)', () => {
  it('is what a signed setup change needs: without one, or with one that is not open, it is refused', async () => {
    const buckle = await node()
    expect((await send(buckle, signed(buckle))).status).toBe(401)
    expect((await send(buckle, signed(buckle, { session: 'AAAAAAAAAAAAAAAAAAAAAA' }))).status).toBe(401)
    const session = await open(buckle)
    expect((await send(buckle, signed(buckle, { session }))).status).toBe(200)
    expect(buckle.runtime.policy.stored().commands.deny).toEqual(['rm *'])
    // The request that opens one names none.
    expect((await send(buckle, signed(buckle, { method: 'POST', path: buckle.setup('sessions'), body: '', session }))).status).toBe(401)
    expect(refusals(buckle)).toEqual(['session_required', 'session_closed', 'session_not_expected'])
  })

  it('refreshes only on a fresh verified request of its own key: forged, replayed, altered and foreign requests refresh nothing', async () => {
    const buckle = await node()
    const session = await open(buckle)
    const genuine = signed(buckle, { session })
    expect((await send(buckle, genuine)).status).toBe(200)
    const before = await lastActivity(buckle, session)
    await new Promise(resolve => setTimeout(resolve, 20))
    // A key nobody enrolled, a replay of the genuine request, an altered body, and another enrolled key naming this session.
    expect((await send(buckle, signed(buckle, { key: stranger, session }))).status).toBe(401)
    expect((await send(buckle, genuine)).status).toBe(401)
    expect((await send(buckle, { ...genuine, call: { ...genuine.call, body: policy.replace('rm *', 'ls') } })).status).toBe(401)
    expect((await send(buckle, signed(buckle, { key: colleague, session }))).status).toBe(401)
    expect(await lastActivity(buckle, session)).toBe(before)
    expect(refusals(buckle)).toEqual(['unknown_key', 'replayed', 'body_mismatch', 'session_closed'])
    // A GET is inspection: it needs the admin credential and touches no session.
    expect((await buckle.request(buckle.setup('status'), { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200)
    expect(await lastActivity(buckle, session)).toBe(before)
    expect((await send(buckle, signed(buckle, { session }))).status).toBe(200)
    expect(Date.parse((await lastActivity(buckle, session))!)).toBeGreaterThan(Date.parse(before!))
  })

  it('closes at once when its key finishes it, and a replay of the close or of an earlier change undoes nothing', async () => {
    const buckle = await node()
    const session = await open(buckle)
    // Signed while the session was open, sent after it closed.
    const earlier = signed(buckle, { session })
    const finish = signed(buckle, { method: 'DELETE', path: buckle.setup(`sessions/${session}`), body: '', session })
    expect((await send(buckle, finish)).status).toBe(204)
    expect((await send(buckle, finish)).status).toBe(401)
    expect((await send(buckle, earlier)).status).toBe(401)
    expect((await send(buckle, signed(buckle, { session }))).status).toBe(401)
    expect(refusals(buckle)).toEqual(['replayed', 'session_closed', 'session_closed'])
    expect(buckle.runtime.policy.stored().updatedAt).toBeNull()
  })

  it('closes every session of a key the owner revokes, and a captured request of it is refused for good', async () => {
    const buckle = await node()
    const session = await open(buckle)
    const captured = signed(buckle, { session })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect((await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['revoke', owner.keyId] })).exitCode).toBe(0)
    expect((await buckle.services.getSetupSessions()).list()).toEqual([])
    expect((await send(buckle, captured)).status).toBe(401)
    expect(refusals(buckle)).toEqual(['unknown_key'])
    expect(buckle.runtime.policy.stored().updatedAt).toBeNull()
  })

  it('is not for the admin credential, which changes setup without one', async () => {
    const buckle = await node()
    const admin = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }
    expect((await buckle.request(buckle.setup('sessions'), { method: 'POST', headers: admin })).status).toBe(400)
    expect((await buckle.request(buckle.setup('policy'), { method: 'PUT', headers: admin, body: policy })).status).toBe(200)
  })
})
