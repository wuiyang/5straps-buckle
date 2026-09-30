import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey, signingKeyFromPem, signRequest } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openFileNonceStore } from '../common/adapters/approval/file-nonce-store.js'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
import { createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { createRequestVerifier } from '../common/services/access/signed-requests.js'

// Review item 3 of the proof-of-possession fixes: the window was judged when a request was checked and
// not again at its nonce claim, so a claim that waited more than 120 s for the lock pruned the original
// nonce and accepted every replay queued behind it. The claim now judges the window with its own clock.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const owner = generateSigningKey()
const nodeKey = generateSigningKey().keyId
const body = JSON.stringify({ version: 1 })

async function verifier() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-verifier-'))
  roots.push(root)
  const keys = createFileClientKeys({ filePath: join(root, 'client-keys.json') })
  await keys.enroll({ publicKey: owner.publicKey, label: 'owner laptop', purpose: 'setup', workspace: 'node' })
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
  return { clock, check, holdLock }
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
