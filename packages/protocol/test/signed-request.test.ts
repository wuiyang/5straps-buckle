import { describe, expect, it } from 'vitest'
import { challengeBytes, generateSigningKey, isSignedRequest, keyIdOf, publicKeyFrom, readChallenge, signChallenge, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS, signingKeyFromPem, signRequest, verifySignedRequest, type ApprovalChallenge, type SignedRequestPurpose, type SignedRequestRefusal } from '../src/signed-request.js'

// Owner ruling H4 of 2026-09-28 and approval-proofs.md, Protocol gates: key substitution, altered
// body, changed arguments, wrong target, replay, cross-purpose reuse, expiry and revocation.

const owner = generateSigningKey()
const other = generateSigningKey()
const now = 1_800_000_000_000
const route = { node: 'node-1', workspace: 'default', method: 'PUT', path: '/setup/policy' }
const body = JSON.stringify({ version: 1, commands: { allow: [], deny: ['rm *'] } })

function signed(input: { key?: typeof owner; purpose?: SignedRequestPurpose; at?: number; ttlMs?: number; body?: string; route?: Partial<typeof route> } = {}): string {
  return signRequest({ key: signingKeyFromPem((input.key ?? owner).privateKeyPem), purpose: input.purpose ?? 'buckle-setup', ...route, ...input.route, body: input.body ?? body, now: input.at ?? now, ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}) })
}

function verifier(input: { enrolled?: string[] } = {}) {
  const enrolled = new Map((input.enrolled ?? [owner.publicKey]).map(key => [keyIdOf(key), publicKeyFrom(key)]))
  const seen = new Set<string>()
  return (authorization: string, options: { purpose?: SignedRequestPurpose; at?: number; body?: string; route?: Partial<typeof route> } = {}): SignedRequestRefusal | 'ok' => {
    const verdict = verifySignedRequest({
      authorization, body: Buffer.from(options.body ?? body), now: options.at ?? now,
      expected: { purpose: options.purpose ?? 'buckle-setup', ...route, ...options.route },
      publicKeyFor: keyId => enrolled.get(keyId) ?? null,
      claim: ({ keyId, nonce }) => {
        if (seen.has(`${keyId}:${nonce}`)) return false
        seen.add(`${keyId}:${nonce}`)
        return true
      },
    })
    return verdict.ok ? 'ok' : verdict.reason
  }
}

describe('a signed request', () => {
  it('verifies for the enrolled key, the exact body and the target it names, and carries no private material', () => {
    const header = signed()
    expect(isSignedRequest(header)).toBe(true)
    expect(verifier()(header)).toBe('ok')
    expect(header).not.toContain(owner.privateKeyPem.split('\n')[1]!.slice(0, 20))
    const payload = JSON.parse(Buffer.from(header.split(' ')[1]!.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['bodySha256', 'expiresAt', 'issuedAt', 'keyId', 'method', 'node', 'nonce', 'path', 'purpose', 'v', 'workspace'])
    expect(payload.keyId).toBe(owner.keyId)
    expect(owner.keyId).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/)
  })

  it('refuses a replay of the same request', () => {
    const verify = verifier()
    const header = signed()
    expect(verify(header)).toBe('ok')
    expect(verify(header, { at: now + 1_000 })).toBe('replayed')
  })

  it('refuses an altered body and changed arguments', () => {
    expect(verifier()(signed(), { body: body.replace('rm *', 'rm -rf *') })).toBe('body_mismatch')
    expect(verifier()(signed(), { body: '' })).toBe('body_mismatch')
  })

  it('refuses a request signed for another node, workspace, method or path', () => {
    for (const changed of [{ node: 'node-2' }, { workspace: 'child' }, { method: 'DELETE' }, { path: '/workspaces/child/setup/policy' }]) {
      expect(verifier()(signed(), { route: changed })).toBe('wrong_target')
    }
  })

  it('refuses reuse across purposes: a setup request on the approval route and an approval on the setup route', () => {
    expect(verifier()(signed({ purpose: 'buckle-setup' }), { purpose: 'buckle-approval' })).toBe('wrong_purpose')
    expect(verifier()(signed({ purpose: 'buckle-approval' }), { purpose: 'buckle-setup' })).toBe('wrong_purpose')
  })

  it('refuses a key that is not enrolled, a revoked one, and a key substituted into the payload', () => {
    expect(verifier()(signed({ key: other }))).toBe('unknown_key')
    expect(verifier({ enrolled: [] })(signed())).toBe('unknown_key')
    // Another key's signature over a payload naming the enrolled key.
    const forged = signed({ key: other })
    const [scheme, token] = forged.split(' ')
    const [encoded, signature] = token!.split('.')
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Record<string, unknown>
    const substituted = `${scheme} ${Buffer.from(JSON.stringify({ ...payload, keyId: owner.keyId })).toString('base64url')}.${signature}`
    expect(verifier()(substituted)).toBe('bad_signature')
  })

  it('refuses expired and future requests, and one that claims to live longer than the maximum', () => {
    expect(verifier()(signed({ at: now - SIGNED_REQUEST_MAX_TTL_MS - SIGNED_REQUEST_SKEW_MS - 1 }))).toBe('expired')
    expect(verifier()(signed({ at: now + SIGNED_REQUEST_SKEW_MS + 1 }))).toBe('expired')
    expect(verifier()(signed({ at: now - SIGNED_REQUEST_MAX_TTL_MS }))).toBe('ok')
    expect(verifier()(signed({ at: now + SIGNED_REQUEST_SKEW_MS }))).toBe('ok')
    // The signer cannot ask for a longer life than the maximum.
    const long = signed({ ttlMs: 10 * 60_000 })
    expect(verifier()(long, { at: now + SIGNED_REQUEST_MAX_TTL_MS + SIGNED_REQUEST_SKEW_MS + 1 })).toBe('expired')
  })

  it('refuses a malformed header without throwing, and never reads a bearer credential as a signed request', () => {
    for (const header of ['5straps-Signed', '5straps-Signed a.b.c', '5straps-Signed !!.??', `5straps-Signed ${Buffer.from('not json').toString('base64url')}.AAAA`]) expect(verifier()(header)).toBe('malformed')
    expect(isSignedRequest('Bearer 5straps-Signed')).toBe(false)
    expect(() => publicKeyFrom('ed25519:short')).toThrow('32 bytes')
  })
})

describe('an approval challenge the node signs (B24)', () => {
  const node = generateSigningKey()
  const challenge: ApprovalChallenge = {
    v: 1, purpose: 'buckle-approval-challenge', node: 'node-1', workspace: 'default', token: 'token-1', requestId: 'a'.repeat(64), sessionId: 'chat-1',
    actor: 'agent:node', tool: 'shell_exec', rule: 'destructive_command', subject: 'rm -rf build', reason: 'Deletes files', offeredScopes: ['once', 'session'],
    callDigest: 'b'.repeat(64), expiresAt: '2026-09-29T10:00:00.000Z',
  }

  it('verifies with the node\'s key, gives back the raw action and the digest a decision names, and is the same bytes every time', () => {
    const signed = signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey })
    expect(readChallenge({ signed: signed.signed, nodeKey: publicKeyFrom(node.publicKey) })).toEqual({ challenge, digest: signed.digest })
    expect(signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey })).toEqual(signed)
    expect(challengeBytes(challenge).digest).toBe(signed.digest)
  })

  it('does not verify under another key, altered, or as a signed request of the same bytes', () => {
    const signed = signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey }).signed
    expect(readChallenge({ signed, nodeKey: publicKeyFrom(owner.publicKey) })).toBeNull()
    const [encoded, signature] = signed.split('.')
    const altered = Buffer.from(JSON.stringify({ ...challenge, subject: 'ls' })).toString('base64url')
    expect(readChallenge({ signed: `${altered}.${signature}`, nodeKey: publicKeyFrom(node.publicKey) })).toBeNull()
    // Signatures are made under separate contexts: a challenge signature is no request signature.
    const asRequest = verifySignedRequest({ authorization: `5straps-Signed ${encoded}.${signature}`, body: Buffer.alloc(0), now, expected: { purpose: 'buckle-approval', ...route }, publicKeyFor: () => publicKeyFrom(node.publicKey), claim: () => true })
    expect(asRequest).toMatchObject({ ok: false })
  })
})
