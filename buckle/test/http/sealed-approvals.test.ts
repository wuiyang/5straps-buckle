import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalKey, mintApprovalKey, open, seal, createMemoryNonceStore, SEALED_REPORT_PATHS, ENVELOPE_WINDOW_MS, type ApprovalKey } from '@5straps/protocol/envelope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@5straps/protocol'
import { challengeBytes, generateSigningKey, signRequest, signingKeyFromPem } from '@5straps/protocol/signed-request'
import { createWebhookNotifier } from '../../common/adapters/approval/webhook-notifier.js'
import { createWebhookReporter } from '../../common/adapters/report/webhook-reporter.js'
import { configFromEnvironment } from '../support/workspace-config.js'
import { settingsCommand } from '../../cli/settings.js'
import { keysCommand } from '../../cli/keys.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { workspaceIdOf } from '../support/workspaces.js'
import { PLAIN_MARKS } from '../../common/domain/permission/decision.js'
import { SOURCES } from '../../common/types/ports/approval-source.js'
import { auditEntries } from '../support/action-log-writer.js'

const ADMIN = { authorization: 'Bearer admin-token-fixture', 'content-type': 'application/json' }
const nodes: BuckleHttp[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const started of nodes.splice(0)) await started.close()
})

/** A workspace folder and where its nonce store will be under `state`, the folder made so the store can be written first. */
function nonceStore(state: string): { workspace: string; nonces: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'buckle-sealed-ws-'))
  const directory = join(state, 'workspaces', workspaceIdOf(workspace))
  mkdirSync(directory, { recursive: true })
  return { workspace, nonces: join(directory, 'approval-nonces.json') }
}

async function node(input: { key?: string; state?: string; workspace?: string; graceMs?: number } = {}) {
  const state = input.state ?? mkdtempSync(join(tmpdir(), 'buckle-sealed-state-'))
  const workspace = input.workspace ?? mkdtempSync(join(tmpdir(), 'buckle-sealed-ws-'))
  const app = await createBuckleHttp({ environment: {
    BUCKLE_AUTH_TOKEN: 'agent-token-fixture',
    BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'admin-token-fixture',
    BUCKLE_STATE_DIR: state,
    BUCKLE_WORKSPACE_ROOT: workspace,
    BUCKLE_ALLOW_SHELL: 'false',
    // A call over HTTP is held this long, so a decision posted meanwhile can free it.
    BUCKLE_APPROVAL_TIMEOUT_MS: String(input.graceMs ?? 1),
    ...(input.key ? { BUCKLE_RINGS_APPROVAL_KEY: input.key } : {}),
  } })
  nodes.push(app)
  const { config, runtime } = app
  const ask = async (complete = true) => ((await runtime.approvals.ask({ tool: 'fs_write', sessionId: 's1', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }], ...(complete ? { call: { arguments: { path: '/outside/fixture.txt', content: 'fixture' }, cwd: config.cwd, description: 'Write fixture.txt', effects: ['write /outside/fixture.txt'], complete: true as const } } : {}) })).requests)[0]!
  const decide = (body: unknown) => app.request(app.setup('approvals'), { method: 'POST', headers: ADMIN, body: JSON.stringify(body) })
  const refusals = async () => (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'setup_approval_envelope_refused')
  return { state, workspace, config, runtime, app, ask, decide, refusals }
}

function sealedDecision(app: BuckleHttp, key: ApprovalKey, token: string, now?: number, approved = true) {
  return seal(key, { method: 'POST', path: app.setup('approvals'), body: { token, approved, scope: 'once' }, ...(now === undefined ? {} : { now }) })
}

async function deviceApproval(app: BuckleHttp, token: string): Promise<Response> {
  const owner = generateSigningKey()
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try { expect((await keysCommand({ config: app.config, workspaces: await app.services.getWorkspaces(), argv: ['enroll', owner.publicKey, '--purpose', 'approval', '--workspace', app.runtime.workspaceId] })).exitCode).toBe(0) }
  finally { output.mockRestore() }
  const challenge = app.runtime.approvalService.challengeListing().challenges.find(entry => entry.token === token)!.challenge!
  const body = JSON.stringify({ token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest })
  const authorization = signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: app.config.serverId, nodeKey: (await app.services.getNodeSigner()).keyId, workspace: app.runtime.workspaceId, method: 'POST', path: app.setup('approvals'), body })
  return app.request(app.setup('approvals'), { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body })
}

describe('sealed approval decisions on the setup face', () => {
  it('refuses unsigned approval even without a paired key, permits denial, and reports re-pair required', async () => {
    const { app, runtime, ask, decide } = await node()
    const token = (await ask()).token
    expect((await decide({ token, approved: true, scope: 'once' })).status).toBe(409)
    expect(runtime.approvals.unspent('s1')).toEqual([])
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect((await decide({ token, approved: false, scope: 'once' })).status).toBe(200)
    const status = await (await app.request(app.setup('status'), { headers: ADMIN })).json() as { approvalEnvelope: string }
    expect(status.approvalEnvelope).toBe('re-pair required')
  })

  it.each([false, true])('refuses approval of an incomplete call and permits denial when paired=%s', async (paired) => {
    const encoded = paired ? mintApprovalKey() : undefined
    const { app, runtime, ask, decide } = await node({ ...(encoded ? { key: encoded } : {}) })
    const token = (await ask(false)).token
    const body = (approved: boolean) => {
      const decision = { token, approved, scope: 'once' }
      return encoded ? seal(approvalKey(encoded), { method: 'POST', path: app.setup('approvals'), body: decision }) : decision
    }
    const rejected = await decide(body(true))
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('enrolled device key') })
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(runtime.approvals.unspent('s1')).toEqual([])
    expect((await decide(body(false))).status).toBe(200)
    expect(runtime.approvals.pending()).toEqual([])
    expect(runtime.approvals.unspent('s1')).toEqual([])
  })

  it('refuses a plain decision once a key is paired, and audits the reason without the body', async () => {
    const { runtime, ask, decide, refusals } = await node({ key: mintApprovalKey() })
    const token = (await ask()).token
    const response = await decide({ token, approved: true, scope: 'once' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Approval decision refused: plain_refused' })
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(await refusals()).toHaveLength(1)
    expect((await refusals())[0]).toMatchObject({ outcome: 'denied', detail: 'plain_refused', args: {} })
    expect(JSON.stringify(await refusals())).not.toContain(token)
  })

  it('opens a sealed denial once and refuses its replay, even after a restart inside the window', async () => {
    const encoded = mintApprovalKey()
    const key = approvalKey(encoded)
    const first = await node({ key: encoded })
    const token = (await first.ask()).token
    const envelope = sealedDecision(first.app, key, token, undefined, false)

    expect((await first.decide(envelope)).status).toBe(200)
    expect(first.runtime.approvals.pending()).toEqual([])
    expect((await first.decide(envelope)).status).toBe(401)

    const restarted = await node({ key: encoded, state: first.state, workspace: first.workspace })
    const replay = await restarted.decide(envelope)
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'Approval decision refused: replayed' })
    expect((await restarted.refusals()).map(entry => entry.detail)).toEqual(expect.arrayContaining(['replayed']))
    expect(readFileSync(join(first.state, 'workspaces', workspaceIdOf(first.workspace), 'approval-nonces.json'), 'utf8')).not.toContain(encoded)
  })

  it('rejects a valid paired sealed approval without resolving the pending ask or granting authority', async () => {
    const encoded = mintApprovalKey()
    const { app, runtime, ask, decide } = await node({ key: encoded })
    const token = (await ask()).token
    const envelope = sealedDecision(app, approvalKey(encoded), token)
    expect((await decide(envelope)).status).toBe(409)
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(runtime.approvals.unspent('s1')).toEqual([])
    expect(runtime.grants.list()).toEqual([])
    expect((await decide(envelope)).status).toBe(401)
    expect((await decide(sealedDecision(app, approvalKey(encoded), token, undefined, false))).status).toBe(200)
  })

  it('prunes nonces whose timestamp has left the window when the store loads', async () => {
    const encoded = mintApprovalKey()
    const key = approvalKey(encoded)
    const state = mkdtempSync(join(tmpdir(), 'buckle-sealed-prune-'))
    // The store is the workspace's, in its own records folder (D85, Q15).
    const { workspace, nonces } = nonceStore(state)
    writeFileSync(nonces, JSON.stringify({ version: 1, nonces: [{ keyId: key.id, nonce: 'old', ts: Date.now() - ENVELOPE_WINDOW_MS * 5 }] }))
    await node({ key: encoded, state, workspace })
    expect(JSON.parse(readFileSync(nonces, 'utf8'))).toEqual({ version: 1, nonces: [] })
  })

  it.skipIf(process.platform === 'win32')('keeps the nonce store owner-only, narrowing one found readable by others (RINGS-D20)', async () => {
    const state = mkdtempSync(join(tmpdir(), 'buckle-sealed-mode-'))
    const { workspace, nonces } = nonceStore(state)
    writeFileSync(nonces, JSON.stringify({ version: 1, nonces: [] }))
    chmodSync(nonces, 0o644)
    await node({ key: mintApprovalKey(), state, workspace })
    expect(statSync(nonces).mode & 0o777).toBe(0o600)
  })

  it('refuses an expired, tampered or foreign envelope and audits each reason', async () => {
    const encoded = mintApprovalKey()
    const key = approvalKey(encoded)
    const { app, ask, decide, refusals, runtime } = await node({ key: encoded })
    const token = (await ask()).token

    expect((await decide(sealedDecision(app, key, token, Date.now() - ENVELOPE_WINDOW_MS - 5_000))).status).toBe(401)
    const envelope = sealedDecision(app, key, token)
    const flipped = `${envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`
    expect((await decide({ ...envelope, ciphertext: flipped })).status).toBe(401)
    expect((await decide(sealedDecision(app, approvalKey(mintApprovalKey()), token))).status).toBe(401)
    const workspaceBound = seal(key, { method: 'POST', path: '/workspaces/other/setup/approvals', body: { token, approved: true, scope: 'once' } })
    expect((await decide(workspaceBound)).status).toBe(401)

    expect((await refusals()).map(entry => entry.detail)).toEqual(['expired', 'tampered', 'unknown_key', 'tampered'])
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(JSON.stringify(await refusals())).not.toContain(encoded)
  })

  it('refuses an envelope while it holds no key, naming the key as unknown', async () => {
    const { app, ask, decide } = await node()
    const response = await decide(sealedDecision(app, approvalKey(mintApprovalKey()), (await ask()).token))
    expect(await response.json()).toEqual({ error: 'Approval decision refused: unknown_key' })
  })

  it('keeps the key out of the manifest and the status, which reports the envelope enabled', async () => {
    const encoded = mintApprovalKey()
    const { app } = await node({ key: encoded })
    const manifestResponse = await app.request('/v1/manifest', { headers: { authorization: 'Bearer agent-token-fixture' } })
    // A refused manifest would pass the key check vacuously (review L7 of B15-B17).
    expect(manifestResponse.status).toBe(200)
    const manifest = await manifestResponse.text()
    const status = await (await app.request(app.setup('status'), { headers: ADMIN })).text()
    expect(manifest).not.toContain(encoded)
    expect(status).not.toContain(encoded)
    expect(JSON.parse(status)).toMatchObject({ approvalEnvelope: 'enabled' })
  })

  it('refuses to start on a malformed key without echoing it', () => {
    expect(() => configFromEnvironment({ BUCKLE_RINGS_APPROVAL_KEY: 'not-a-key-fixture-zq81', BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-sealed-bad-')), BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-sealed-bad-ws-')) }))
      .toThrow(/^BUCKLE_RINGS_APPROVAL_KEY is not an approval key \(32 bytes in base64url\); remove it, or set the key this node shares with its control plane$/)
    try { configFromEnvironment({ BUCKLE_RINGS_APPROVAL_KEY: 'not-a-key-fixture-zq81' }) } catch (error) { expect(String(error)).not.toContain('zq81') }
  })
})

describe('sealed reports to Rings', () => {
  const request: ApprovalRequest = { token: 'tok-zq81', rule: 'write_scope', subject: '/outside', reason: 'outside', tool: 'fs_write', offeredScopes: ['once'], expiresAt: new Date(Date.now() + 60_000).toISOString() }

  function capture() {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response('{}', { status: 201 })
    }))
    return bodies
  }

  it('seals the approval notification and the report for their Rings routes once a key is paired', async () => {
    const key = approvalKey(mintApprovalKey())
    const bodies = capture()
    await createWebhookNotifier({ url: 'http://rings.test/api/v1/buckle-approvals', serverId: 'n1', workspaceId: 'default', token: 'rt', approvalKey: key })([request])
    await createWebhookReporter({ url: 'http://rings.test/api/v1/buckle-reports', token: 'rt', serverId: 'n1', approvalKey: key }).report({
      event: 'denied_run', serverId: 'n1', workspace: '/w', at: new Date().toISOString(), requestId: 'r1', sessionId: 's1',
      tool: 'fs_write', effects: [], args: {}, rule: 'write_scope', subject: '/outside', reason: 'outside',
    })

    expect(JSON.stringify(bodies)).not.toContain('tok-zq81')
    const seen = createMemoryNonceStore()
    expect(open(key, bodies[0], { method: 'POST', path: SEALED_REPORT_PATHS.approvals, now: Date.now(), seen })).toMatchObject({ serverId: 'n1', approvals: [{ token: 'tok-zq81' }] })
    expect(open(key, bodies[1], { method: 'POST', path: SEALED_REPORT_PATHS.reports, now: Date.now(), seen })).toMatchObject({ event: 'denied_run' })
  })

  it('sends them plain while the node holds no key', async () => {
    const bodies = capture()
    await createWebhookNotifier({ url: 'http://rings.test/api/v1/buckle-approvals', serverId: 'n1', workspaceId: 'default', token: 'rt' })([request])
    expect(bodies[0]).toMatchObject({ serverId: 'n1', approvals: [{ token: 'tok-zq81' }] })
  })
})

describe('buckle settings show', () => {
  it('lists the approval key as set and hidden, never its value', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-sealed-settings-'))
    const encoded = mintApprovalKey()
    writeFileSync(join(directory, 'node.env'), `BUCKLE_SERVER_NAME=zq81\nBUCKLE_STATE_DIR=${join(directory, 'state')}\nBUCKLE_RINGS_APPROVAL_KEY=${encoded}\n`)
    let printed = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
    try {
      expect((await settingsCommand({ argv: ['show'], environment: {}, environmentFile: 'node.env', cwd: directory })).exitCode).toBe(0)
    } finally { out.mockRestore() }
    expect(printed).toContain('BUCKLE_RINGS_APPROVAL_KEY (set, hidden)')
    expect(printed).not.toContain(encoded)
  })
})

describe('a decision posted to the setup face', () => {
  it('keeps a call gated after unsigned approval, then frees only the exact call through an enrolled device', async () => {
    const { app, runtime, decide } = await node({ graceMs: 60_000 })
    const answer = vi.spyOn(runtime.approvalService, 'answer')
    const outside = mkdtempSync(join(tmpdir(), 'buckle-sealed-outside-'))
    const waiting = app.request('/v1/invoke', { method: 'POST', headers: { authorization: 'Bearer agent-token-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'held', tool: 'fs_write', args: { path: join(outside, 'note.md'), content: 'freed' }, approvalTokens: [], context: { sessionId: 's1' } }) }).then(response => response.json())
    await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
    const token = runtime.approvals.pending()[0]!.token

    expect((await decide({ token, approved: true, scope: 'once' })).status).toBe(409)
    // The envelope's source only denies, so the decision guard refuses its approval and nothing is decided.
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ source: SOURCES.sealed }))
    await expect(answer.mock.results[0]!.value).resolves.toEqual({ ok: false, code: 'capability_exceeded', reason: 'Approval requires an enrolled device key: review and confirm with buckle client approve' })
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect((await deviceApproval(app, token)).status).toBe(200)

    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.devices, challenge: expect.any(String), decidedBy: expect.stringMatching(/^key:SHA256:/), consumeNotAfter: expect.any(Number) }))
    expect(await waiting).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(outside, 'note.md'), 'utf8')).toBe('freed')
  })
})
