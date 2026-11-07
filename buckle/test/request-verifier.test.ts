import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey, signingKeyFromPem, signRequest, SIGNED_REQUEST_MAX_TTL_MS } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openFileNonceStore } from '../common/adapters/approval/file-nonce-store.js'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
import { createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { createRequestVerifier } from '../common/services/access/signed-requests.js'
import { isDeviceProof } from '../common/services/approvals/device-proof.js'

// Review item 3 of the proof-of-possession fixes: the window was judged when a request was checked and
// not again at its nonce claim, so a claim that waited more than 120 s for the lock pruned the original
// nonce and accepted every replay queued behind it. The claim now judges the window with its own clock.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const owner = generateSigningKey()
const nodeKey = generateSigningKey().keyId
const body = JSON.stringify({ version: 1 })

async function verifier(purpose: 'setup' | 'approval' | 'both' = 'setup') {
  const root = mkdtempSync(join(tmpdir(), 'buckle-verifier-'))
  roots.push(root)
  const keys = createFileClientKeys({ filePath: join(root, 'client-keys.json') })
  await keys.enroll({ publicKey: owner.publicKey, label: 'owner laptop', purpose, workspace: 'node' })
  const clock = { now: 1_800_000_000_000 }
  const noncePath = join(root, 'request-nonces.json')
  const nonces = await openFileNonceStore({ filePath: noncePath, now: () => clock.now })
  const verify = createRequestVerifier({ keys, nonces, serverId: 'node-1', nodeKeyId: nodeKey, now: () => clock.now })
  const request = signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-setup', node: 'node-1', nodeKey, workspace: 'default', method: 'PUT', path: '/setup/policy', body, now: clock.now })
  const check = () => verify.verify({ authorization: request, purpose: 'buckle-setup', workspaceId: 'default', registry: false, method: 'PUT', path: '/setup/policy', body: Buffer.from(body) })
  /** Holds the nonce store's lock, as a slow disk or another process would, until released. */
  function holdLock(): () => Promise<void> {
    const holder = createJsonFileStore({ filePath: noncePath, schema: z.unknown(), fallback: {} })
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    const held = holder.update(() => released)
    return async () => { release(); await held }
  }
  return { clock, check, holdLock, verify }
}

describe('a nonce claim that waited for the lock', () => {
  it('is refused as expired once the window has passed, so no replay queued behind it is accepted', async () => {
    const { clock, check, holdLock } = await verifier()
    expect(await check()).toMatchObject({ ok: true })
    expect(await check()).toMatchObject({ ok: false, reason: 'replayed' })

    const release = holdLock()
    // Checked now, inside the window; claimed 211 s later, past it and past the pruning of the original.
    const replays = Array.from({ length: 5 }, () => check())
    clock.now += 211_000
    await release()
    for (const replay of await Promise.all(replays)) expect(replay).toMatchObject({ ok: false, reason: 'expired', claimedKeyId: owner.keyId })
  })

  it('still claims a request whose wait ended inside the window', async () => {
    const { clock, check, holdLock } = await verifier()
    const release = holdLock()
    const first = check()
    clock.now += 30_000
    await release()
    expect(await first).toMatchObject({ ok: true })
  })
})


describe('node-owned approval proof custody', () => {
  it('takes the deadline only from verified signature metadata, never forged request context', async () => {
    const { verify, clock } = await verifier('both')
    const request = { context: { proofDeadline: clock.now + 999_999, approvalProofDeadline: clock.now + 999_999, actor: `key:${owner.keyId}` } }
    expect(verify.approvalProof(request)?.deadline).toBeUndefined()
    const authorization = signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-approval', node: 'node-1', nodeKey, workspace: 'default', method: 'POST', path: '/setup/approvals', body, now: clock.now })
    const signed = { requestIdentity: request, authorization, purpose: 'buckle-approval' as const, workspaceId: 'default', registry: false, method: 'POST', path: '/setup/approvals', body: Buffer.from(body) }
    expect(await verify.verify(signed)).toMatchObject({ ok: true })
    expect(verify.approvalProof(request)?.deadline).toBe(clock.now + SIGNED_REQUEST_MAX_TTL_MS)
    expect(isDeviceProof(verify.approvalProof(request))).toBe(true)
    expect(verify.approvalProof(request)?.keyId).toBe(owner.keyId)
    request.context.proofDeadline += 999_999
    request.context.approvalProofDeadline += 999_999
    expect(verify.approvalProof(request)?.deadline).toBe(clock.now + SIGNED_REQUEST_MAX_TTL_MS)
    expect(verify.approvalProof({ context: request.context })?.deadline).toBeUndefined()
    const otherNode = await verifier('both')
    expect(otherNode.verify.approvalProof(request)?.deadline).toBeUndefined()
    expect(await verify.verify(signed)).toMatchObject({ ok: false, reason: 'replayed' })
    expect(verify.approvalProof(request)?.deadline).toBeUndefined()
  })

  it('does not create approval authority for invalid signatures or verified setup purpose', async () => {
    const { verify, clock } = await verifier('both')
    const request = { context: { proofDeadline: clock.now + 999_999 } }
    const input = { requestIdentity: request, authorization: 'forged', purpose: 'buckle-approval' as const, workspaceId: 'default', registry: false, method: 'POST', path: '/setup/approvals', body: Buffer.from(body) }
    expect(await verify.verify(input)).toMatchObject({ ok: false })
    expect(verify.approvalProof(request)?.deadline).toBeUndefined()
    const authorization = signRequest({ key: signingKeyFromPem(owner.privateKeyPem), purpose: 'buckle-setup', node: 'node-1', nodeKey, workspace: 'default', method: 'POST', path: '/setup/policy', body, now: clock.now })
    expect(await verify.verify({ ...input, authorization, purpose: 'buckle-setup', path: '/setup/policy' })).toMatchObject({ ok: true })
    expect(verify.approvalProof(request)?.deadline).toBeUndefined()
  })
})
