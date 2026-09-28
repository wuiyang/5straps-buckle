import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvokeRequest } from '@5straps/protocol'
import { generateSigningKey, publicKeyFrom, readChallenge, signingKeyFromPem, signRequest, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand, CLIENT_KEY_FILE } from '../../cli/client.js'
import { keysCommand } from '../../cli/keys.js'
import { nodeKeyPath } from '../../common/runtime/config.js'
import { requestFingerprint } from '../../common/services/invocation/executions.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// B24, approval-proofs.md: the node signs each waiting ask as a challenge with its own key; a person's
// client verifies it with the node key it pinned, shows the raw action from it, and signs a decision
// over its digest. The decision is consumed once, lives at most 60 s after it was signed, answers only
// that ask, and never lets an approval past a deny the node finds when the call runs.

const ADMIN = 'approval-proofs-admin-token'
const nodes: BuckleHttp[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const node of nodes.splice(0)) await node.close() })

const owner = generateSigningKey()

async function node(): Promise<BuckleHttp & { root: string }> {
  const { root, environment } = nodeEnvironment('buckle-approval-proofs-', { BUCKLE_AUTH_TOKEN: 'approval-proofs-agent-token', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect((await keysCommand({ config: started.config, argv: ['enroll', owner.publicKey] })).exitCode).toBe(0)
  vi.mocked(process.stdout.write).mockRestore()
  return Object.assign(started, { root })
}

function write(root: string, requestId: string, name = 'outside.md'): InvokeRequest {
  return { requestId, tool: 'fs_write', args: { path: join(root, name), content: 'written' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } }
}

async function ask(buckle: BuckleHttp & { root: string }, request: InvokeRequest): Promise<string> {
  const asked = await buckle.runtime.invoke({ sessionId: 'chat-1', request })
  if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
  return asked.approvals[0]!.token
}

function signed(buckle: BuckleHttp, input: { method: string; path: string; body: string; at?: number }): string {
  return signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: buckle.config.serverId, workspace: 'default', method: input.method, path: input.path, body: input.body, now: input.at ?? Date.now() })
}

async function challenges(buckle: BuckleHttp): Promise<{ node: { keyId: string; publicKey: string }; challenges: Array<{ token: string; signed: string; digest: string }> }> {
  const path = '/setup/approvals/challenges'
  const response = await buckle.request(path, { headers: { authorization: signed(buckle, { method: 'GET', path, body: '' }) } })
  expect(response.status).toBe(200)
  return await response.json() as Awaited<ReturnType<typeof challenges>>
}

function decide(buckle: BuckleHttp, body: object, at?: number): { send: () => Promise<Response> } {
  const text = JSON.stringify(body)
  const authorization = signed(buckle, { method: 'POST', path: '/setup/approvals', body: text, ...(at ? { at } : {}) })
  return { send: () => buckle.request('/setup/approvals', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: text }) }
}

describe('an approval decision a person\'s key proves (B24)', () => {
  it('shows each waiting ask as the node signed it, raw, and answers exactly the ask whose challenge it names', async () => {
    const buckle = await node()
    const request = write(buckle.root, 'proof-1')
    const token = await ask(buckle, request)
    const listed = await challenges(buckle)
    const signer = await buckle.services.getNodeSigner()
    expect(listed.node).toEqual({ keyId: signer.keyId, publicKey: signer.publicKey })
    const [item] = listed.challenges
    const verified = readChallenge({ signed: item!.signed, nodeKey: publicKeyFrom(signer.publicKey) })
    expect(verified?.digest).toBe(item!.digest)
    expect(verified?.challenge).toMatchObject({ node: buckle.config.serverId, workspace: 'default', token, tool: 'fs_write', rule: 'write_scope', sessionId: 'chat-1', callDigest: requestFingerprint(request) })
    // Signed once, the same challenge every time.
    expect((await challenges(buckle)).challenges).toEqual(listed.challenges)

    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    expect(await buckle.runtime.invoke({ sessionId: 'chat-1', request: { ...request, context: {} } })).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(buckle.root, 'outside.md'), 'utf8')).toBe('written')
  })

  it('refuses a decision on another ask\'s challenge, one naming none, a replay, an expired one, and one signed after its key was revoked', async () => {
    const buckle = await node()
    const first = await ask(buckle, write(buckle.root, 'proof-a', 'a.md'))
    const second = await ask(buckle, write(buckle.root, 'proof-b', 'sub/b.md'))
    const listed = await challenges(buckle)
    const digestOf = (token: string) => listed.challenges.find(item => item.token === token)!.digest
    // Another ask's challenge: the decision answers what the person was shown, or nothing.
    expect((await decide(buckle, { token: first, approved: true, scope: 'once', challenge: digestOf(second) }).send()).status).toBe(409)
    expect((await decide(buckle, { token: first, approved: true, scope: 'once' }).send()).status).toBe(400)
    const expired = decide(buckle, { token: first, approved: true, scope: 'once', challenge: digestOf(first) }, Date.now() - SIGNED_REQUEST_MAX_TTL_MS - SIGNED_REQUEST_SKEW_MS - 1_000)
    expect((await expired.send()).status).toBe(401)
    const denial = decide(buckle, { token: first, approved: false, scope: 'once', challenge: digestOf(first) })
    expect((await denial.send()).status).toBe(200)
    expect((await denial.send()).status).toBe(401)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await keysCommand({ config: buckle.config, argv: ['revoke', owner.keyId] })
    expect((await decide(buckle, { token: second, approved: true, scope: 'once', challenge: digestOf(second) }).send()).status).toBe(401)
    expect(buckle.runtime.approvals.pending().map(request => request.token)).toEqual([second])
    expect(buckle.runtime.actions.read(200).filter(entry => entry.tool === 'setup_signed_request_refused').map(entry => entry.detail)).toEqual(['expired', 'replayed', 'unknown_key'])
  })

  it('never takes an approval past a deny the node finds when the call runs: a rule the owner adds after the decision still refuses it', async () => {
    const buckle = await node()
    const request = write(buckle.root, 'proof-deny')
    const token = await ask(buckle, request)
    const [item] = (await challenges(buckle)).challenges
    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    const denyFsWrite = JSON.stringify({ version: 1, tools: { deny: ['fs_write'] } })
    expect((await buckle.request('/setup/policy', { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: denyFsWrite })).status).toBe(200)
    expect(await buckle.runtime.invoke({ sessionId: 'chat-1', request: { ...request, context: {} } })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  })

  it('reaches Rings\' relay with nothing secret: public keys, signatures and digests only', async () => {
    const buckle = await node()
    const token = await ask(buckle, write(buckle.root, 'proof-relay'))
    const listed = await challenges(buckle)
    const decision = decide(buckle, { token, approved: false, scope: 'once', challenge: listed.challenges[0]!.digest })
    const relayed = JSON.stringify(listed)
    const nodePem = readFileSync(nodeKeyPath(buckle.config), 'utf8')
    for (const secret of [owner.privateKeyPem, nodePem]) {
      for (const line of secret.split('\n').filter(part => part && !part.startsWith('-----'))) expect(relayed).not.toContain(line)
    }
    expect(Object.keys(listed.node).sort()).toEqual(['keyId', 'publicKey'])
    expect((await decision.send()).status).toBe(200)
  })

  it('is what `buckle client approve` sends, after it verified the challenge with the pinned node key and showed the raw action', async () => {
    const buckle = await node()
    const url = await buckle.listen()
    const environment = { BUCKLE_CLIENT_DIR: join(mkdtempSync(join(buckle.root, 'client-')), 'device') }
    const output = { stdout: '', stderr: '' }
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.stdout += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.stderr += String(chunk); return true })
    expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
    writeFileSync(join(environment.BUCKLE_CLIENT_DIR, CLIENT_KEY_FILE), owner.privateKeyPem, { mode: 0o600 })
    const token = await ask(buckle, write(buckle.root, 'proof-client'))

    // Not pinned yet: nothing is shown or signed.
    expect((await clientCommand(['approve', url, token], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain('is not pinned on this device')
    // Pinned to the wrong key: the node's challenges do not verify, so none is shown.
    expect((await clientCommand(['trust', buckle.config.serverId, generateSigningKey().publicKey], environment)).exitCode).toBe(0)
    expect((await clientCommand(['approve', url, token], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain(`No waiting ask ${token}`)

    output.stdout = ''
    await keysCommand({ config: buckle.config, argv: ['node'] })
    const nodeKey = /Public key: +(ed25519:\S+)/.exec(output.stdout)![1]!
    expect((await clientCommand(['trust', buckle.config.serverId, nodeKey], environment)).exitCode).toBe(0)
    output.stdout = ''
    expect((await clientCommand(['approvals', url], environment)).exitCode).toBe(0)
    expect(output.stdout).toContain(`${token}  fs_write asks write_scope`)
    expect((await clientCommand(['approve', url, token, '--deny'], environment)).exitCode).toBe(0)
    expect(buckle.runtime.approvals.pending()).toEqual([])
  })
})
