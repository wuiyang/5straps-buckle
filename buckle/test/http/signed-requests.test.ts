import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { mintApprovalKey } from '@5straps/protocol/envelope'
import { generateSigningKey, signingKeyFromPem, signRequest, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS, type SignedRequestPurpose } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand } from '../../cli/client.js'
import { keysCommand } from '../../cli/keys.js'
import { enrollEarlierKey } from '../support/earlier-keys.js'
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
const relays: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const relay of relays.splice(0)) await new Promise(resolve => relay.close(resolve))
  for (const node of nodes.splice(0)) await node.close()
})

const owner = generateSigningKey()
const stranger = generateSigningKey()
const policy = JSON.stringify({ version: 1, commands: { allow: [], deny: ['rm *'] }, network: { allow: [] }, mount: null, updatedAt: null })

type Node = BuckleHttp & { workspace: string; root: string; nodeKey: string }

async function node(extra: Record<string, string> = {}, options: { instance?: 1 | 2; enroll?: boolean } = {}): Promise<Node> {
  const { root, workspace, environment } = nodeEnvironment('buckle-signed-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs', ...extra })
  const started = await createBuckleHttp({ environment, ...(options.instance ? { instance: options.instance } : {}) })
  nodes.push(started)
  if (options.enroll !== false) await enrollEarlierKey(started.config, owner.publicKey, 'owner laptop')
  return Object.assign(started, { workspace, root, nodeKey: (await started.services.getNodeSigner()).keyId })
}

interface Signing { key?: typeof owner; purpose?: SignedRequestPurpose; method?: string; path?: string; body?: string; workspace?: string; node?: string; nodeKey?: string; at?: number; session?: string }

function sign(buckle: Node, input: Signing = {}): string {
  return signRequest({
    key: signingKeyFromPem((input.key ?? owner).privateKeyPem), purpose: input.purpose ?? 'buckle-setup', node: input.node ?? buckle.config.serverId, nodeKey: input.nodeKey ?? buckle.nodeKey,
    workspace: input.workspace ?? 'default', method: input.method ?? 'PUT', path: input.path ?? '/setup/policy', body: input.body ?? policy, now: input.at ?? Date.now(),
    ...(input.session ? { session: input.session } : {}),
  })
}

/** Opens a setup session for the owner's key (B24): signed setup changes name it. */
async function openSession(buckle: Node): Promise<string> {
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
    expect(buckle.runtime.policy.stored().commands.deny).toEqual(['rm *'])
    expect((await buckle.request('/setup/policy', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200)
    expect(buckle.runtime.policy.stored().commands.deny).toEqual([])
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
      ['wrong_target', sign(buckle, { nodeKey: generateSigningKey().keyId }), {}],
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
    // Each refusal names the key its payload claims, when one could be read (review H4 of B23-B25).
    const claimed = buckle.runtime.actions.read(200).filter(entry => entry.tool === 'setup_signed_request_refused').map(entry => (entry.args as { claimedKeyId?: string }).claimedKeyId)
    expect(claimed).toEqual([...cases.slice(0, -2).map(() => owner.keyId), stranger.keyId, undefined])
    expect(buckle.runtime.policy.stored().updatedAt).toBeNull()
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
    expect((await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['revoke', owner.keyId] })).exitCode).toBe(0)
    expect((await send(buckle, sign(buckle, { session }))).status).toBe(401)
    // Enrolling the same key again does not undo the revocation.
    expect((await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['enroll', owner.publicKey, '--purpose', 'setup', '--workspace', 'node'] })).exitCode).toBe(1)
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
    expect((await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['enroll', publicKey, '--label', 'device', '--purpose', 'setup', '--workspace', 'default'] })).exitCode).toBe(0)
    const body = JSON.stringify({ version: 1, network: { allow: ['example.com'] } })
    // Nothing is signed for a node this device has not pinned under the URL typed (owner decision D11).
    expect((await clientCommand(['session', 'open', url], environment)).exitCode).toBe(1)
    printed = ''
    await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['node'] })
    const nodeKey = /Public key: +(ed25519:\S+)/.exec(printed)![1]!
    expect((await clientCommand(['trust', url, buckle.config.serverId, nodeKey], environment)).exitCode).toBe(0)
    printed = ''
    expect((await clientCommand(['session', 'open', url], environment)).exitCode).toBe(0)
    const session = printed.trim()
    expect((await clientCommand(['request', 'PUT', `${url}/setup/policy`, '--body', body, '--session', session], environment)).exitCode).toBe(0)
    expect(buckle.runtime.policy.stored().network.allow).toEqual(['example.com'])
    // A --node that is not the node pinned for this URL signs nothing.
    expect((await clientCommand(['request', 'PUT', `${url}/setup/policy`, '--body', body, '--node', 'another-node', '--session', session], environment)).exitCode).toBe(1)
    expect((await clientCommand(['session', 'close', url, session], environment)).exitCode).toBe(0)
    expect((await clientCommand(['request', 'PUT', `${url}/setup/policy`, '--body', body, '--session', session], environment)).exitCode).toBe(1)
  })
})

/** The key's session on a workspace, opened with a request it signed; the status when it is refused. */
async function sessionOn(buckle: Node, key: typeof owner, workspace: string): Promise<string | number> {
  const path = workspace === 'default' ? '/setup/sessions' : `/workspaces/${workspace}/setup/sessions`
  const response = await send(buckle, sign(buckle, { key, workspace, method: 'POST', path, body: '' }), { method: 'POST', path, body: '' })
  return response.status === 201 ? (await response.json() as { session: { id: string } }).session.id : response.status
}

describe('a key\'s scope over three children (owner decision D10)', () => {
  it('signs only its purpose on its own workspace, and only a node-scoped setup key changes the registry', async () => {
    const buckle = await node({}, { enroll: false })
    const workspaces = await buckle.services.getWorkspaces()
    for (const id of ['child-a', 'child-b', 'child-c']) {
      const root = join(buckle.root, id)
      mkdirSync(root)
      await workspaces.create({ id, name: id, dir: root })
    }
    const setupOnA = generateSigningKey(), approvalOnB = generateSigningKey(), setupOnDefault = generateSigningKey(), setupOnNode = generateSigningKey()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    for (const [key, purpose, workspace] of [[setupOnA, 'setup', 'child-a'], [approvalOnB, 'approval', 'child-b'], [setupOnDefault, 'setup', 'default'], [setupOnNode, 'setup', 'node']] as const) {
      expect((await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['enroll', key.publicKey, '--purpose', purpose, '--workspace', workspace] })).exitCode).toBe(0)
    }
    expect(typeof await sessionOn(buckle, setupOnA, 'child-a')).toBe('string')
    expect(await sessionOn(buckle, setupOnA, 'child-b')).toBe(401)
    expect(await sessionOn(buckle, setupOnA, 'default')).toBe(401)
    expect(await sessionOn(buckle, approvalOnB, 'child-b')).toBe(401)
    const approvals = '/workspaces/child-b/setup/approvals/challenges'
    expect((await send(buckle, sign(buckle, { key: approvalOnB, purpose: 'buckle-approval', workspace: 'child-b', method: 'GET', path: approvals, body: '' }), { method: 'GET', path: approvals, body: '' })).status).toBe(200)
    const approvalsOnC = '/workspaces/child-c/setup/approvals/challenges'
    expect((await send(buckle, sign(buckle, { key: approvalOnB, purpose: 'buckle-approval', workspace: 'child-c', method: 'GET', path: approvalsOnC, body: '' }), { method: 'GET', path: approvalsOnC, body: '' })).status).toBe(401)

    // The registry: a key on the default workspace alone is refused; a node-scoped setup key is let in.
    const rename = JSON.stringify({ name: 'Renamed' })
    const registryPath = '/setup/workspaces/child-c'
    const onDefault = await sessionOn(buckle, setupOnDefault, 'default')
    expect((await send(buckle, sign(buckle, { key: setupOnDefault, method: 'PATCH', path: registryPath, body: rename, session: String(onDefault) }), { method: 'PATCH', path: registryPath, body: rename })).status).toBe(401)
    const onNode = await sessionOn(buckle, setupOnNode, 'default')
    const renamed = await send(buckle, sign(buckle, { key: setupOnNode, method: 'PATCH', path: registryPath, body: rename, session: String(onNode) }), { method: 'PATCH', path: registryPath, body: rename })
    expect(renamed.status).toBe(200)
    expect(refusals(buckle)).toEqual(['out_of_scope', 'out_of_scope', 'out_of_scope', 'out_of_scope', 'out_of_scope'])
    // The registry change names the key that made it (review H4 of B23-B25).
    expect(buckle.runtime.actions.read(200).filter(entry => entry.tool === 'http_workspace_registry_patch' && entry.event === 'result' && entry.outcome === 'ok').map(entry => entry.actorId)).toEqual([`key:${setupOnNode.keyId}`])
  })
})

describe('the node a request is signed for (owner decision D11)', () => {
  it('refuses a request signed for another node that shares its serverId', async () => {
    const first = await node()
    const second = await node({}, { instance: 2 })
    expect(first.config.serverId).toBe(second.config.serverId)
    expect(first.nodeKey).not.toBe(second.nodeKey)
    const forFirst = sign(first, { method: 'POST', path: '/setup/sessions', body: '' })
    expect((await send(second, forFirst, { method: 'POST', path: '/setup/sessions', body: '' })).status).toBe(401)
    expect(refusals(second)).toEqual(['wrong_target'])
    expect((await send(first, forFirst, { method: 'POST', path: '/setup/sessions', body: '' })).status).toBe(201)
  })

  it('never signs for what a relay\'s /health says: unpinned it signs nothing, pinned as another node the node refuses it', async () => {
    const buckle = await node()
    const target = await buckle.listen()
    // Relay X answers /health with the node's serverId and forwards everything else to it.
    const relay = createServer(async (request, response) => {
      if (request.url === '/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok', serverId: buckle.config.serverId })); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const forwarded = await fetch(`${target}${request.url}`, { method: request.method, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'content-length'].includes(name)).map(([name, value]) => [name, String(value)])), ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      response.statusCode = forwarded.status
      response.end(Buffer.from(await forwarded.arrayBuffer()))
    })
    relays.push(relay)
    await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
    const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`
    const environment = { BUCKLE_CLIENT_DIR: join(mkdtempSync(join(buckle.root, 'client-')), 'device') }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
    writeFileSync(join(environment.BUCKLE_CLIENT_DIR, 'client-key.pem'), owner.privateKeyPem, { mode: 0o600 })

    expect((await clientCommand(['session', 'open', relayUrl], environment)).exitCode).toBe(1)
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('is not pinned on this device')
    expect(refusals(buckle)).toEqual([])
    // The person pinned X as the node it really is; the node behind it refuses what X relays.
    expect((await clientCommand(['trust', relayUrl, 'relay-x', generateSigningKey().publicKey], environment)).exitCode).toBe(0)
    expect((await clientCommand(['session', 'open', relayUrl], environment)).exitCode).toBe(1)
    const body = JSON.stringify({ version: 1, network: { allow: ['meant-for-x.example'] } })
    expect((await clientCommand(['request', 'PUT', `${relayUrl}/setup/policy`, '--body', body, '--session', 'AAAAAAAAAAAAAAAAAAAAAA'], environment)).exitCode).toBe(1)
    expect(buckle.runtime.policy.stored().updatedAt).toBeNull()
    expect(refusals(buckle)).toEqual(['wrong_target', 'wrong_target'])
  })
})

describe('who signed, in the audit (review H4 of B23-B25)', () => {
  it('names the key on a session open, a policy change, a challenge read and a decision, and on the decision\'s grant', async () => {
    const buckle = await node()
    const actor = `key:${owner.keyId}`
    const session = await openSession(buckle)
    expect((await send(buckle, sign(buckle, { session }))).status).toBe(200)
    const asked = await buckle.runtime.invoke({ sessionId: 's', request: { requestId: 'attributed-ask', tool: 'fs_write', args: { path: join(buckle.root, 'outside.md'), content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    const token = asked.approvals[0]!.token
    const challenges = '/setup/approvals/challenges'
    const listed = await (await send(buckle, sign(buckle, { purpose: 'buckle-approval', method: 'GET', path: challenges, body: '' }), { method: 'GET', path: challenges, body: '' })).json() as { challenges: Array<{ token: string; digest: string }> }
    const decision = JSON.stringify({ token, approved: true, scope: 'session', challenge: listed.challenges[0]!.digest })
    expect((await send(buckle, sign(buckle, { purpose: 'buckle-approval', method: 'POST', path: '/setup/approvals', body: decision }), { method: 'POST', path: '/setup/approvals', body: decision })).status).toBe(200)

    const attributed = (tool: string) => buckle.runtime.actions.read(200).filter(entry => entry.tool === tool).map(entry => [entry.event, entry.actorId])
    expect(attributed('setup_post_sessions')).toEqual([['attempt', actor], ['result', actor]])
    expect(attributed('setup_put_policy')).toEqual([['attempt', actor], ['result', actor]])
    expect(attributed('setup_get_approvals-challenges')).toEqual([['result', actor]])
    expect(attributed('setup_post_approvals')).toEqual([['attempt', actor], ['result', actor]])
    expect(buckle.runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session', decidedBy: actor })])
    // The admin credential is named too.
    expect((await buckle.request('/setup/policy', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200)
    expect(attributed('setup_delete_policy')).toEqual([['attempt', 'admin:default'], ['result', 'admin:default']])
  })
})

describe('a node with no BUCKLE_ADMIN_TOKEN and the flag on (review M4 of B23-B25)', () => {
  it('answers a signed request 404, as when the face is not there, and audits nothing', async () => {
    const buckle = await node({ BUCKLE_ADMIN_TOKEN: '' })
    const before = buckle.runtime.actions.read(500).length
    const response = await send(buckle, sign(buckle, { method: 'POST', path: '/setup/sessions', body: '' }), { method: 'POST', path: '/setup/sessions', body: '' })
    expect(response.status).toBe(404)
    expect((await send(buckle, sign(buckle))).status).toBe(404)
    expect(buckle.runtime.actions.read(500).length).toBe(before)
    expect((await buckle.services.getSetupSessions()).list()).toEqual([])
  })
})
