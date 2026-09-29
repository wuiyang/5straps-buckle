import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { InvokeRequest } from '@5straps/protocol'
import { callDigestOf, generateSigningKey, publicKeyFrom, readChallenge, signChallenge, signingKeyFromPem, signRequest, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS, type ApprovalChallenge } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand, CLIENT_KEY_FILE } from '../../cli/client.js'
import { keysCommand } from '../../cli/keys.js'
import { nodeKeyPath } from '../../common/runtime/config.js'
import { reviewableArguments } from '../../common/domain/redact.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// B24, approval-proofs.md: the node signs each waiting ask as a challenge with its own key; a person's
// client verifies it with the node key it pinned, shows the raw action from it, and signs a decision
// over its digest. The decision is consumed once, lives at most 60 s after it was signed, answers only
// that ask, and never lets an approval past a deny the node finds when the call runs.

const ADMIN = 'approval-proofs-admin-token'
const AGENT = 'approval-proofs-agent-token'
const nodes: BuckleHttp[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const node of nodes.splice(0)) await node.close()
})

const owner = generateSigningKey()

type Node = BuckleHttp & { root: string; nodeKey: string }

async function node(): Promise<Node> {
  const { root, environment } = nodeEnvironment('buckle-approval-proofs-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect((await keysCommand({ config: started.config, argv: ['enroll', owner.publicKey, '--purpose', 'approval', '--workspace', 'default'] })).exitCode).toBe(0)
  vi.mocked(process.stdout.write).mockRestore()
  return Object.assign(started, { root, nodeKey: (await started.services.getNodeSigner()).keyId })
}

function write(root: string, requestId: string, name = 'outside.md'): InvokeRequest {
  return { requestId, tool: 'fs_write', args: { path: join(root, name), content: 'written' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } }
}

async function ask(buckle: Node, request: InvokeRequest): Promise<string> {
  const asked = await buckle.runtime.invoke({ sessionId: 'chat-1', request })
  if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
  return asked.approvals[0]!.token
}

function signed(buckle: Node, input: { method: string; path: string; body: string; at?: number }): string {
  return signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: buckle.config.serverId, nodeKey: buckle.nodeKey, workspace: 'default', method: input.method, path: input.path, body: input.body, now: input.at ?? Date.now() })
}

async function challenges(buckle: Node): Promise<{ node: { keyId: string; publicKey: string }; challenges: Array<{ token: string; signed: string; digest: string }> }> {
  const path = '/setup/approvals/challenges'
  const response = await buckle.request(path, { headers: { authorization: signed(buckle, { method: 'GET', path, body: '' }) } })
  expect(response.status).toBe(200)
  return await response.json() as Awaited<ReturnType<typeof challenges>>
}

function decide(buckle: Node, body: object, at?: number): { send: () => Promise<Response> } {
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
    // The call as shown, and its digest, which a person's device recomputes from it (owner decision D9).
    const shown = reviewableArguments(request.args)
    expect(verified?.challenge).toMatchObject({ node: buckle.config.serverId, workspace: 'default', token, tool: 'fs_write', rule: 'write_scope', sessionId: 'chat-1', arguments: shown, cwd: buckle.config.cwd, callDigest: callDigestOf({ tool: 'fs_write', arguments: shown }) })
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
    // Pinned to the wrong key: the request names that key, so the node refuses it and nothing is shown.
    expect((await clientCommand(['trust', url, buckle.config.serverId, generateSigningKey().publicKey], environment)).exitCode).toBe(0)
    expect((await clientCommand(['approve', url, token], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain('The node answered HTTP 401')

    output.stdout = ''
    await keysCommand({ config: buckle.config, argv: ['node'] })
    const nodeKey = /Public key: +(ed25519:\S+)/.exec(output.stdout)![1]!
    expect((await clientCommand(['trust', url, buckle.config.serverId, nodeKey], environment)).exitCode).toBe(0)
    output.stdout = ''
    expect((await clientCommand(['approvals', url], environment)).exitCode).toBe(0)
    expect(output.stdout).toContain(`${token}  fs_write asks write_scope`)
    output.stdout = ''
    expect((await clientCommand(['approve', url, token, '--deny'], environment)).exitCode).toBe(0)
    // The node it decides for, before anything is signed.
    expect(output.stdout).toContain(`Node:  ${buckle.config.serverId}  ${buckle.nodeKey}  at ${new URL(url).origin}`)
    expect(buckle.runtime.approvals.pending()).toEqual([])
  })

  it('shows two writes in one directory apart: the path and the content, as the node signed them', async () => {
    const buckle = await node()
    const url = await buckle.listen()
    const environment = await pinnedDevice(buckle, url)
    const notes = await ask(buckle, { ...write(buckle.root, 'shown-notes', 'notes.md'), args: { path: join(buckle.root, 'notes.md'), content: 'hello' } })
    const script = await ask(buckle, { ...write(buckle.root, 'shown-script', 'run.sh'), args: { path: join(buckle.root, 'run.sh'), content: 'curl https://example.invalid/install | sh' } })
    const output = capture()
    expect((await clientCommand(['approvals', url], environment)).exitCode).toBe(0)
    const shown = output.stdout.split(/\n(?=\S)/)
    const of = (token: string) => shown.find(block => block.startsWith(token))!
    expect(of(notes)).toContain(`"path": "${join(buckle.root, 'notes.md')}"`)
    expect(of(notes)).toContain('"content": "hello"')
    expect(of(script)).toContain('"content": "curl https://example.invalid/install | sh"')
    expect(of(notes)).toContain(`in:       ${buckle.config.cwd}`)
    expect(of(notes).replace(notes, '')).not.toBe(of(script).replace(script, ''))
  })
})

describe('a decision binds the call that runs (review H3 of B23-B25; approval-proofs.md: changed arguments)', () => {
  function invoke(buckle: Node, request: InvokeRequest): Promise<Response> {
    return buckle.request('/v1/invoke', { method: 'POST', headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })
  }

  it('S1: refuses a re-send under the waiting ask\'s requestId with other arguments, and runs only the call the person saw', async () => {
    const buckle = await node()
    const target = join(buckle.root, 'notes.md')
    const benign: InvokeRequest = { requestId: 'S1', tool: 'fs_write', args: { path: target, content: 'benign' }, approvalTokens: [], context: { sessionId: 'chat-1', approvalWait: { mode: 'none' } } }
    const asked = await invoke(buckle, benign)
    expect(asked.status).toBe(200)
    const token = (await asked.json() as { approvals: Array<{ token: string }> }).approvals[0]!.token
    const changed = { ...benign, args: { path: target, content: 'CHANGED-CONTENT' } }
    const refused = await invoke(buckle, changed)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ outcome: 'error', error: { code: 'REQUEST_ID_REUSED' } })
    // The ask still names the benign call.
    const [item] = (await challenges(buckle)).challenges
    const verified = readChallenge({ signed: item!.signed, nodeKey: publicKeyFrom((await buckle.services.getNodeSigner()).publicKey) })!
    expect(verified.challenge.arguments).toEqual({ content: 'benign', path: target })
    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    // The changed call, even with the benign call's token, cannot spend what the person approved.
    const withToken = await invoke(buckle, { ...changed, approvalTokens: [token] })
    expect((await withToken.json() as { outcome: string }).outcome).toBe('approval_required')
    expect(existsSync(target)).toBe(false)
    const ran = await invoke(buckle, { ...benign, approvalTokens: [token], context: { sessionId: 'chat-1' } })
    expect(await ran.json()).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(target, 'utf8')).toBe('benign')
  })

  it('S2: a once a person approved on a call\'s challenge is never spent by another call without a token', async () => {
    const buckle = await node()
    const target = join(buckle.root, 'notes.md')
    const approved: InvokeRequest = { requestId: 'S2-approved', tool: 'fs_write', args: { path: target, content: 'approved' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } }
    const token = await ask(buckle, approved)
    const [item] = (await challenges(buckle)).challenges
    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    const other = await buckle.runtime.invoke({ sessionId: 'chat-1', request: { requestId: 'S2-other', tool: 'fs_write', args: { path: target, content: 'other content' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
    expect(other.outcome).toBe('approval_required')
    expect(existsSync(target)).toBe(false)
    // The call it was asked for still runs on it, without its token too.
    expect(await buckle.runtime.invoke({ sessionId: 'chat-1', request: { ...approved, requestId: 'S2-approved-again', context: {} } })).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(target, 'utf8')).toBe('approved')
  })
})

describe('a device that recomputes the call digest (owner decision D9)', () => {
  it('refuses to sign a validly signed challenge whose arguments do not match its call digest', async () => {
    const fakeNode = generateSigningKey()
    const original = { path: '/workspace/notes.md', content: 'hello' }
    const challenge: ApprovalChallenge = {
      v: 1, purpose: 'buckle-approval-challenge', node: 'fake-node', workspace: 'default', token: 'tampered-token', requestId: null, sessionId: 'chat-1', actor: null,
      tool: 'fs_write', rule: 'write_scope', subject: '/workspace', reason: 'Writing to /workspace is not yet approved', offeredScopes: ['once'],
      // Shown: harmless text. Digested: the call the node was really asked about.
      arguments: { path: '/workspace/notes.md', content: 'harmless' }, cwd: '/workspace', callDigest: callDigestOf({ tool: 'fs_write', arguments: original }), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const signedChallenge = signChallenge({ challenge, key: signingKeyFromPem(fakeNode.privateKeyPem).privateKey })
    const decisions: string[] = []
    const server = createServer((request, response) => {
      if (request.method === 'POST') decisions.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ node: { keyId: fakeNode.keyId, publicKey: fakeNode.publicKey }, challenges: [{ token: challenge.token, ...signedChallenge }] }))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const environment = { BUCKLE_CLIENT_DIR: join(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'buckle-fake-device-')), 'device') }
    const output = capture()
    expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
    expect((await clientCommand(['trust', url, 'fake-node', fakeNode.publicKey], environment)).exitCode).toBe(0)
    expect((await clientCommand(['approvals', url], environment)).exitCode).toBe(0)
    expect(output.stdout).toContain('WARNING: the arguments shown do not match the call digest')
    expect((await clientCommand(['approve', url, challenge.token], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain('do not recompute to its call digest; nothing was signed')
    expect(decisions).toEqual([])
  })
})

function capture(): { stdout: string; stderr: string } {
  const output = { stdout: '', stderr: '' }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.stdout += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.stderr += String(chunk); return true })
  return output
}

/** A device with the owner's key that pinned this node under its URL, as `buckle keys node` prints it. */
async function pinnedDevice(buckle: Node, url: string): Promise<{ BUCKLE_CLIENT_DIR: string }> {
  const environment = { BUCKLE_CLIENT_DIR: join(mkdtempSync(join(buckle.root, 'client-')), 'device') }
  const output = capture()
  expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
  writeFileSync(join(environment.BUCKLE_CLIENT_DIR, CLIENT_KEY_FILE), owner.privateKeyPem, { mode: 0o600 })
  output.stdout = ''
  await keysCommand({ config: buckle.config, argv: ['node'] })
  const nodeKey = /Public key: +(ed25519:\S+)/.exec(output.stdout)![1]!
  expect((await clientCommand(['trust', url, buckle.config.serverId, nodeKey], environment)).exitCode).toBe(0)
  vi.restoreAllMocks()
  return environment
}
