import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalKey, mintApprovalKey, open, seal, createMemoryNonceStore, SEALED_REPORT_PATHS, ENVELOPE_WINDOW_MS, type ApprovalKey } from '@5straps/protocol/envelope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@5straps/protocol'
import { createWebhookNotifier } from '../common/adapters/approval/webhook-notifier.js'
import { createWebhookReporter } from '../common/adapters/report/webhook-reporter.js'
import { loadConfig } from '../common/runtime/config.js'
import { settingsCommand } from '../cli/settings.js'
import { createHttpApp } from '../server/hono/http-app.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'

const ADMIN = { authorization: 'Bearer admin-token-fixture', 'content-type': 'application/json' }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function node(input: { key?: string; state?: string } = {}) {
  const state = input.state ?? mkdtempSync(join(tmpdir(), 'buckle-sealed-state-'))
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: 'agent-token-fixture',
    BUCKLE_ADMIN_TOKEN: 'admin-token-fixture',
    BUCKLE_STATE_DIR: state,
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-sealed-ws-')),
    BUCKLE_ALLOW_SHELL: 'false',
    ...(input.key ? { BUCKLE_RINGS_APPROVAL_KEY: input.key } : {}),
  })
  // Held for the grace period, as a call over HTTP is, so a decision posted meanwhile can free it.
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  const app = createHttpApp({ config, runtime, authToken: config.authToken })
  const ask = async () => ((await runtime.approvals.ask({ tool: 'fs_write', sessionId: 's1', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })).requests)[0]!
  const decide = (body: unknown) => app.request('/setup/approvals', { method: 'POST', headers: ADMIN, body: JSON.stringify(body) })
  const refusals = () => runtime.actions.read(200).filter(entry => entry.tool === 'setup_approval_envelope_refused')
  return { state, config, runtime, app, ask, decide, refusals }
}

function sealedDecision(key: ApprovalKey, token: string, now?: number) {
  return seal(key, { method: 'POST', path: '/setup/approvals', body: { token, approved: true, scope: 'once' }, ...(now === undefined ? {} : { now }) })
}

describe('sealed approval decisions on the setup face', () => {
  it('accepts a plain decision while the node holds no key, and reports that a re-pair is required', async () => {
    const { app, ask, decide } = await node()
    expect((await decide({ token: (await ask()).token, approved: true, scope: 'once' })).status).toBe(200)
    const status = await (await app.request('/setup/status', { headers: ADMIN })).json() as { approvalEnvelope: string }
    expect(status.approvalEnvelope).toBe('re-pair required')
  })

  it('refuses a plain decision once a key is paired, and audits the reason without the body', async () => {
    const { runtime, ask, decide, refusals } = await node({ key: mintApprovalKey() })
    const token = (await ask()).token
    const response = await decide({ token, approved: true, scope: 'once' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Approval decision refused: plain_refused' })
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]).toMatchObject({ outcome: 'denied', detail: 'plain_refused', args: {} })
    expect(JSON.stringify(refusals())).not.toContain(token)
  })

  it('opens a sealed decision once and refuses its replay, even after a restart inside the window', async () => {
    const encoded = mintApprovalKey()
    const key = approvalKey(encoded)
    const first = await node({ key: encoded })
    const token = (await first.ask()).token
    const envelope = sealedDecision(key, token)

    expect((await first.decide(envelope)).status).toBe(200)
    expect(first.runtime.approvals.pending()).toEqual([])
    expect((await first.decide(envelope)).status).toBe(401)

    const restarted = await node({ key: encoded, state: first.state })
    const replay = await restarted.decide(envelope)
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'Approval decision refused: replayed' })
    expect(restarted.refusals().map(entry => entry.detail)).toEqual(expect.arrayContaining(['replayed']))
    expect(readFileSync(join(first.state, 'approval-nonces.json'), 'utf8')).not.toContain(encoded)
  })

  it('prunes nonces whose timestamp has left the window when the store loads', async () => {
    const encoded = mintApprovalKey()
    const key = approvalKey(encoded)
    const state = mkdtempSync(join(tmpdir(), 'buckle-sealed-prune-'))
    writeFileSync(join(state, 'approval-nonces.json'), JSON.stringify({ version: 1, nonces: [{ keyId: key.id, nonce: 'old', ts: Date.now() - ENVELOPE_WINDOW_MS * 5 }] }))
    await node({ key: encoded, state })
    expect(JSON.parse(readFileSync(join(state, 'approval-nonces.json'), 'utf8'))).toEqual({ version: 1, nonces: [] })
  })

  it.skipIf(process.platform === 'win32')('keeps the nonce store owner-only, narrowing one found readable by others (RINGS-D20)', async () => {
    const state = mkdtempSync(join(tmpdir(), 'buckle-sealed-mode-'))
    const nonces = join(state, 'approval-nonces.json')
    writeFileSync(nonces, JSON.stringify({ version: 1, nonces: [] }))
    chmodSync(nonces, 0o644)
    await node({ key: mintApprovalKey(), state })
    expect(statSync(nonces).mode & 0o777).toBe(0o600)
  })

  it('refuses an expired, tampered or foreign envelope and audits each reason', async () => {
    const encoded = mintApprovalKey()
    const key = approvalKey(encoded)
    const { ask, decide, refusals, runtime } = await node({ key: encoded })
    const token = (await ask()).token

    expect((await decide(sealedDecision(key, token, Date.now() - ENVELOPE_WINDOW_MS - 5_000))).status).toBe(401)
    const envelope = sealedDecision(key, token)
    const flipped = `${envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`
    expect((await decide({ ...envelope, ciphertext: flipped })).status).toBe(401)
    expect((await decide(sealedDecision(approvalKey(mintApprovalKey()), token))).status).toBe(401)
    const workspaceBound = seal(key, { method: 'POST', path: '/workspaces/other/setup/approvals', body: { token, approved: true, scope: 'once' } })
    expect((await decide(workspaceBound)).status).toBe(401)

    expect(refusals().map(entry => entry.detail)).toEqual(['expired', 'tampered', 'unknown_key', 'tampered'])
    expect(runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(JSON.stringify(refusals())).not.toContain(encoded)
  })

  it('refuses an envelope while it holds no key, naming the key as unknown', async () => {
    const { ask, decide } = await node()
    const response = await decide(sealedDecision(approvalKey(mintApprovalKey()), (await ask()).token))
    expect(await response.json()).toEqual({ error: 'Approval decision refused: unknown_key' })
  })

  it('keeps the key out of the manifest and the status, which reports the envelope enabled', async () => {
    const encoded = mintApprovalKey()
    const { app } = await node({ key: encoded })
    const manifest = await (await app.request('/v1/manifest', { headers: { authorization: 'Bearer agent-token-fixture' } })).text()
    const status = await (await app.request('/setup/status', { headers: ADMIN })).text()
    expect(manifest).not.toContain(encoded)
    expect(status).not.toContain(encoded)
    expect(JSON.parse(status)).toMatchObject({ approvalEnvelope: 'enabled' })
  })

  it('refuses to start on a malformed key without echoing it', () => {
    expect(() => loadConfig({ BUCKLE_RINGS_APPROVAL_KEY: 'not-a-key-fixture-zq81', BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-sealed-bad-')), BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-sealed-bad-ws-')) }))
      .toThrow(/^BUCKLE_RINGS_APPROVAL_KEY is not a key Rings minted/)
    try { loadConfig({ BUCKLE_RINGS_APPROVAL_KEY: 'not-a-key-fixture-zq81' }) } catch (error) { expect(String(error)).not.toContain('zq81') }
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
  it('is answered through the approval service, as the owner, and frees the call waiting on it', async () => {
    const { runtime, decide } = await node()
    const answer = vi.spyOn(runtime.approvalService, 'answer')
    const outside = mkdtempSync(join(tmpdir(), 'buckle-sealed-outside-'))
    const waiting = runtime.invoke({ sessionId: 's1', request: { requestId: 'held', tool: 'fs_write', args: { path: join(outside, 'note.md'), content: 'freed' }, approvalTokens: [] } })
    await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
    const token = runtime.approvals.pending()[0]!.token

    expect((await decide({ token, approved: true, scope: 'once' })).status).toBe(200)

    expect(answer).toHaveBeenCalledWith({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })
    expect(await waiting).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(outside, 'note.md'), 'utf8')).toBe('freed')
  })
})
