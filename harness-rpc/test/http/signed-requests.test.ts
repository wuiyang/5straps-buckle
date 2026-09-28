import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { mintApprovalKey } from '@5straps/protocol/envelope'
import { generateSigningKey, signingKeyFromPem, signRequest, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS, type SignedRequestPurpose } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand } from '../../cli/client.js'
import { keysCommand } from '../../cli/keys.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// B23, owner ruling H4 of 2026-09-28: the setup and approval guards accept a request a person's
// enrolled key signed, as well as the admin credential for now; inspection stays on the admin
// credential. Every refusal is a bare 401, audited with its reason on the owner's log only.
// approval-proofs.md, Protocol gates: key substitution, altered body, changed arguments, wrong
// target, replay, cross-purpose reuse, expired and future timestamps, revoked keys.

const AGENT = 'signed-requests-agent-token'
const ADMIN = 'signed-requests-admin-token'
const nodes: BuckleHttp[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const node of nodes.splice(0)) await node.close() })

const owner = generateSigningKey()
const stranger = generateSigningKey()
const policy = JSON.stringify({ version: 1, commands: { allow: [], deny: ['rm *'] }, network: { allow: [] }, mount: null, updatedAt: null })

async function node(extra: Record<string, string> = {}): Promise<BuckleHttp & { workspace: string; root: string }> {
  const { root, workspace, environment } = nodeEnvironment('buckle-signed-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs', ...extra })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect((await keysCommand({ config: started.config, argv: ['enroll', owner.publicKey, '--label', 'owner laptop'] })).exitCode).toBe(0)
  vi.mocked(process.stdout.write).mockRestore()
  return Object.assign(started, { workspace, root })
}

interface Signing { key?: typeof owner; purpose?: SignedRequestPurpose; method?: string; path?: string; body?: string; workspace?: string; node?: string; at?: number; session?: string }

function sign(buckle: BuckleHttp, input: Signing = {}): string {
  return signRequest({
    key: signingKeyFromPem((input.key ?? owner).privateKeyPem), purpose: input.purpose ?? 'buckle-setup', node: input.node ?? buckle.config.serverId,
    workspace: input.workspace ?? 'default', method: input.method ?? 'PUT', path: input.path ?? '/setup/policy', body: input.body ?? policy, now: input.at ?? Date.now(),
    ...(input.session ? { session: input.session } : {}),
  })
}

/** Opens a setup session for the owner's key (B24): signed setup changes name it. */
async function openSession(buckle: BuckleHttp): Promise<string> {
  const response = await send(buckle, sign(buckle, { method: 'POST', path: '/setup/sessions', body: '' }), { method: 'POST', path: '/setup/sessions', body: '' })
  expect(response.status).toBe(201)
  return (await response.json() as { session: { id: string } }).session.id
}

function send(buckle: BuckleHttp, authorization: string, input: { method?: string; path?: string; body?: string } = {}): Promise<Response> {
  const body = input.body ?? policy
  return buckle.request(input.path ?? '/setup/policy', { method: input.method ?? 'PUT', headers: { authorization, 'content-type': 'application/json' }, ...(body ? { body } : {}) })
}

function refusals(buckle: BuckleHttp): Array<string | undefined> {
  return buckle.runtime.actions.read(200).filter(entry => entry.tool === 'setup_signed_request_refused').map(entry => entry.detail)
}

describe('a request the enrolled key signed (B23)', () => {
  it('opens the setup guard as that key, and the admin credential still does', async () => {
    const buckle = await node()
    const signed = await send(buckle, sign(buckle, { session: await openSession(buckle) }))
    expect(signed.status).toBe(200)
    expect(buckle.runtime.policy.stored()?.commands.deny).toEqual(['rm *'])
    expect((await buckle.request('/setup/policy', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200)
    expect(buckle.runtime.policy.stored()).toBeNull()
    expect(refusals(buckle)).toEqual([])
  })

  it('opens the approval guard for a plain decision, on the workspace twin as well, where a paired node refuses a plain one with the admin credential', async () => {
    const buckle = await node({ BUCKLE_RINGS_APPROVAL_KEY: mintApprovalKey() })
    const asked = await buckle.runtime.invoke({ sessionId: 's', request: { requestId: 'signed-ask', tool: 'fs_write', args: { path: join(buckle.root, 'outside.md'), content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    const token = asked.approvals[0]!.token
    const path = '/workspaces/default/setup/approvals'
    // With a key paired, Rings' admin credential carries a decision sealed; plain, it is refused.
    expect((await buckle.request(path, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ token, approved: false, scope: 'once' }) })).status).toBe(401)
    // A signed decision names the challenge the node signed for the ask (B24).
    const challenges = '/workspaces/default/setup/approvals/challenges'
    const listed = await (await send(buckle, sign(buckle, { purpose: 'buckle-approval', method: 'GET', path: challenges, body: '' }), { method: 'GET', path: challenges, body: '' })).json() as { challenges: Array<{ token: string; digest: string }> }
    const decision = JSON.stringify({ token, approved: false, scope: 'once', challenge: listed.challenges.find(item => item.token === token)!.digest })
    const answered = await send(buckle, sign(buckle, { purpose: 'buckle-approval', method: 'POST', path, body: decision }), { method: 'POST', path, body: decision })
    expect(answered.status).toBe(200)
    expect(buckle.runtime.approvals.pending()).toEqual([])
  })

  it('refuses every mismatch with a bare 401 and audits its reason for the owner', async () => {
    const buckle = await node()
    const now = Date.now()
    const cases: Array<[string, string, { method?: string; path?: string; body?: string }]> = [
      ['body_mismatch', sign(buckle), { body: policy.replace('rm *', 'curl *') }],
      ['body_mismatch', sign(buckle), { body: JSON.stringify({ ...JSON.parse(policy) as object, network: { allow: ['*'] } }) }],
      ['wrong_target', sign(buckle, { workspace: 'child' }), {}],
      ['wrong_target', sign(buckle, { node: 'another-node' }), {}],
      ['wrong_target', sign(buckle, { path: '/workspaces/default/setup/policy' }), {}],
      ['wrong_target', sign(buckle, { method: 'POST' }), {}],
      ['wrong_purpose', sign(buckle, { purpose: 'buckle-approval' }), {}],
      ['expired', sign(buckle, { at: now - SIGNED_REQUEST_MAX_TTL_MS - SIGNED_REQUEST_SKEW_MS - 1_000 }), {}],
      ['expired', sign(buckle, { at: now + SIGNED_REQUEST_SKEW_MS + 60_000 }), {}],
      ['unknown_key', sign(buckle, { key: stranger }), {}],
      ['malformed', '5straps-Signed not-a-signed-request', {}],
    ]
    for (const [reason, authorization, request] of cases) {
      const response = await send(buckle, authorization, request)
      expect({ reason, status: response.status }).toEqual({ reason, status: 401 })
      // Nothing tells an unauthenticated caller which check failed.
      expect(await response.json()).toEqual({ error: 'Unauthorized' })
    }
    expect(refusals(buckle)).toEqual(cases.map(([reason]) => reason))
    expect(buckle.runtime.policy.stored()).toBeNull()
  })

  it('refuses a replay, an approval signature on the setup guard and a setup signature on the approval guard, and a key substituted into the payload', async () => {
    const buckle = await node()
    const once = sign(buckle, { session: await openSession(buckle) })
    expect((await send(buckle, once)).status).toBe(200)
    expect((await send(buckle, once)).status).toBe(401)
    const decision = JSON.stringify({ token: 'x', approved: true, scope: 'once' })
    expect((await send(buckle, sign(buckle, { method: 'POST', path: '/setup/approvals', body: decision }), { method: 'POST', path: '/setup/approvals', body: decision })).status).toBe(401)
    const forged = sign(buckle, { key: stranger })
    const [scheme, token] = forged.split(' ')
    const [encoded, signature] = token!.split('.')
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Record<string, unknown>
    const substituted = `${scheme} ${Buffer.from(JSON.stringify({ ...payload, keyId: owner.keyId })).toString('base64url')}.${signature}`
    expect((await send(buckle, substituted)).status).toBe(401)
    expect(refusals(buckle)).toEqual(['replayed', 'wrong_purpose', 'bad_signature'])
  })

  it('refuses a key once the owner revokes it, at once and for good', async () => {
    const buckle = await node()
    const session = await openSession(buckle)
    expect((await send(buckle, sign(buckle, { session }))).status).toBe(200)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect((await keysCommand({ config: buckle.config, argv: ['revoke', owner.keyId] })).exitCode).toBe(0)
    expect((await send(buckle, sign(buckle, { session }))).status).toBe(401)
    // Enrolling the same key again does not undo the revocation.
    expect((await keysCommand({ config: buckle.config, argv: ['enroll', owner.publicKey] })).exitCode).toBe(1)
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('was revoked')
    expect((await send(buckle, sign(buckle, { session }))).status).toBe(401)
    expect(refusals(buckle)).toEqual(['unknown_key', 'unknown_key'])
  })

  it('keeps inspection on the admin credential: a signed read is refused', async () => {
    const buckle = await node()
    const response = await send(buckle, sign(buckle, { method: 'GET', path: '/setup/status', body: '' }), { method: 'GET', path: '/setup/status', body: '' })
    expect(response.status).toBe(401)
    expect((await buckle.request('/setup/status', { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200)
  })

  it('is what `buckle client request` sends: a device key made with `buckle client keygen`, enrolled with `buckle keys enroll`', async () => {
    const buckle = await node()
    const url = await buckle.listen()
    const environment = { BUCKLE_CLIENT_DIR: join(mkdtempSync(join(buckle.root, 'client-')), 'device') }
    let printed = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
    const publicKey = /Public key: +(ed25519:\S+)/.exec(printed)![1]!
    expect((await keysCommand({ config: buckle.config, argv: ['enroll', publicKey, '--label', 'device'] })).exitCode).toBe(0)
    const body = JSON.stringify({ version: 1, network: { allow: ['example.com'] } })
    printed = ''
    expect((await clientCommand(['session', 'open', url], environment)).exitCode).toBe(0)
    const session = printed.trim()
    expect((await clientCommand(['request', 'PUT', `${url}/setup/policy`, '--body', body, '--session', session], environment)).exitCode).toBe(0)
    expect(buckle.runtime.policy.stored()?.network.allow).toEqual(['example.com'])
    // The node names itself on /health; a pinned --node that is not this node is refused.
    expect((await clientCommand(['request', 'PUT', `${url}/setup/policy`, '--body', body, '--node', 'another-node', '--session', session], environment)).exitCode).toBe(1)
    expect((await clientCommand(['session', 'close', url, session], environment)).exitCode).toBe(0)
    expect((await clientCommand(['request', 'PUT', `${url}/setup/policy`, '--body', body, '--session', session], environment)).exitCode).toBe(1)
  })
})
