import { createHash, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { callDigestOf, isSmallOrderPoint, SmallOrderKeyError, canonicalJson, challengeBytes, generateSigningKey, isSignedRequest, keyIdOf, publicKeyFrom, readChallenge, signChallenge, SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_SKEW_MS, signingKeyFromPem, signRequest, verifySignedRequest, WORKSPACE_NAME_MAX, type ApprovalChallenge, type SignedRequestPurpose, type SignedRequestRefusal } from '../src/signed-request.js'

// Owner ruling H4 of 2026-09-28 and approval-proofs.md, Protocol gates: key substitution, altered
// body, changed arguments, wrong target, replay, cross-purpose reuse, expiry and revocation.

const owner = generateSigningKey()
const other = generateSigningKey()
const nodeKey = generateSigningKey().keyId
const now = 1_800_000_000_000
const route = { node: 'node-1', nodeKey, workspace: 'default', method: 'PUT', path: '/setup/policy' }
const body = JSON.stringify({ version: 1, commands: { allow: [], deny: ['rm *'] } })

function signed(input: { key?: typeof owner; purpose?: SignedRequestPurpose; at?: number; ttlMs?: number; body?: string; route?: Partial<typeof route> } = {}): string {
  return signRequest({ key: signingKeyFromPem((input.key ?? owner).privateKeyPem), purpose: input.purpose ?? 'buckle-setup', ...route, ...input.route, body: input.body ?? body, now: input.at ?? now, ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}) })
}

function verifier(input: { enrolled?: string[]; outOfScope?: string[] } = {}) {
  const enrolled = new Map((input.enrolled ?? [owner.publicKey]).map(key => [keyIdOf(key), publicKeyFrom(key)]))
  const seen = new Set<string>()
  return (authorization: string, options: { purpose?: SignedRequestPurpose; at?: number; body?: string; route?: Partial<typeof route> } = {}): SignedRequestRefusal | 'ok' => {
    const verdict = verifySignedRequest({
      authorization, body: Buffer.from(options.body ?? body), now: options.at ?? now,
      expected: { purpose: options.purpose ?? 'buckle-setup', ...route, ...options.route },
      publicKeyFor: ({ keyId }) => {
        const key = enrolled.get(keyId)
        return key ? { key, covers: !input.outOfScope?.includes(keyId) } : { refused: 'unknown_key' }
      },
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
    expect(Object.keys(payload).sort()).toEqual(['bodySha256', 'expiresAt', 'issuedAt', 'keyId', 'method', 'node', 'nodeKey', 'nonce', 'path', 'purpose', 'v', 'workspace'])
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

  it('refuses a request signed for another node, another node key under the same serverId, workspace, method or path', () => {
    for (const changed of [{ node: 'node-2' }, { nodeKey: generateSigningKey().keyId }, { workspace: 'child' }, { method: 'DELETE' }, { path: '/workspaces/child/setup/policy' }]) {
      expect(verifier()(signed(), { route: changed })).toBe('wrong_target')
    }
  })

  it('refuses a key enrolled for another purpose or workspace once it proved the signature, and names the claimed key', () => {
    expect(verifier({ outOfScope: [owner.keyId] })(signed())).toBe('out_of_scope')
    const verdict = verifySignedRequest({ authorization: signed({ key: other }), body: Buffer.from(body), now, expected: { purpose: 'buckle-setup', ...route }, publicKeyFor: () => ({ refused: 'unknown_key' }), claim: () => true })
    expect(verdict).toEqual({ ok: false, reason: 'unknown_key', claimedKeyId: other.keyId })
  })

  // Review item 17 of the proof-of-possession fixes: a stranger naming an enrolled key out of its scope
  // was refused as out_of_scope, so the owner's log blamed a device that signed nothing.
  it('refuses a stranger who names an out-of-scope key as a bad signature, never as that key reaching out of scope', () => {
    const forged = signRequest({ key: signingKeyFromPem(other.privateKeyPem), purpose: 'buckle-setup', ...route, body, now })
    const payload = JSON.parse(Buffer.from(forged.split(' ')[1]!.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const claimsOwner = `5straps-Signed ${Buffer.from(JSON.stringify({ ...payload, keyId: owner.keyId })).toString('base64url')}.${forged.split('.')[1]}`
    expect(verifier({ outOfScope: [owner.keyId] })(claimsOwner)).toBe('bad_signature')
  })

  it('refuses reuse across purposes: a setup request on the approval route and an approval on the setup route', () => {
    expect(verifier()(signed({ purpose: 'buckle-setup' }), { purpose: 'buckle-approval' })).toBe('wrong_purpose')
    expect(verifier()(signed({ purpose: 'buckle-approval' }), { purpose: 'buckle-setup' })).toBe('wrong_purpose')
  })

  it('refuses a key that is not enrolled, a revoked one, and a key substituted into the payload', () => {
    expect(verifier()(signed({ key: other }))).toBe('unknown_key')
    expect(verifier({ enrolled: [] })(signed())).toBe('unknown_key')
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
    arguments: { args: ['-rf', 'build'], command: 'rm' }, cwd: '/workspace', callDigest: callDigestOf({ tool: 'shell_exec', arguments: { command: 'rm', args: ['-rf', 'build'] } }),
    truncated: false, description: 'Run `rm -rf build` in /workspace', expiresAt: '2026-09-29T10:00:00.000Z',
  }

  it('carries a call digest a person\'s device recomputes from the arguments it shows, whatever order their keys came in', () => {
    expect(callDigestOf({ tool: challenge.tool, arguments: challenge.arguments! })).toBe(challenge.callDigest)
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}')
    // A changed argument is a different call.
    expect(callDigestOf({ tool: challenge.tool, arguments: { command: 'rm', args: ['-rf', '/'] } })).not.toBe(challenge.callDigest)
    expect(callDigestOf({ tool: 'script_run', arguments: challenge.arguments! })).not.toBe(challenge.callDigest)
  })

  it('verifies with the node\'s key, gives back the raw action and the digest a decision names, and is the same bytes every time', () => {
    const signed = signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey })
    expect(readChallenge({ signed: signed.signed, nodeKey: publicKeyFrom(node.publicKey) })).toEqual({ challenge, digest: signed.digest })
    expect(signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey })).toEqual(signed)
    expect(challengeBytes(challenge).digest).toBe(signed.digest)
  })

  // Fix brief 4, finding 13: a device showed the workspace's UUID alone. The name is optional, so a node built before it
  // signs what it always signed, and the protocol version stays 1.
  it('carries the workspace\'s name beside its id where the node sends one, and reads one without it as before', () => {
    const named: ApprovalChallenge = { ...challenge, workspace: 'a9f9e5a2-52ac-5720-bc81-771fd12913c6', workspaceName: 'The site' }
    const signed = signChallenge({ challenge: named, key: signingKeyFromPem(node.privateKeyPem).privateKey })
    expect(readChallenge({ signed: signed.signed, nodeKey: publicKeyFrom(node.publicKey) })).toEqual({ challenge: named, digest: signed.digest })
    expect(named.v).toBe(1)
    const unnamed = readChallenge({ signed: signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey }).signed, nodeKey: publicKeyFrom(node.publicKey) })
    expect(unnamed?.challenge).not.toHaveProperty('workspaceName')
    // A relay that renames the workspace breaks the node's signature.
    const [, signature] = signed.signed.split('.')
    const renamed = Buffer.from(JSON.stringify({ ...named, workspaceName: 'Another' })).toString('base64url')
    expect(readChallenge({ signed: `${renamed}.${signature}`, nodeKey: publicKeyFrom(node.publicKey) })).toBeNull()
  })

  it('refuses an empty workspace name, or one longer than a registry holds', () => {
    for (const workspaceName of ['', 'n'.repeat(WORKSPACE_NAME_MAX + 1)]) expect(() => challengeBytes({ ...challenge, workspaceName })).toThrow()
    expect(() => challengeBytes({ ...challenge, workspaceName: 'n'.repeat(WORKSPACE_NAME_MAX) })).not.toThrow()
  })

  // APPROVAL-37: the folder and its subfolders a device may grant is signed with the rest, so a relay cannot widen it.
  it('carries the ask\'s wider subject where the node sends one, which a relay cannot change', () => {
    const wider: ApprovalChallenge = { ...challenge, widerSubject: 'delete-below:/srv/data' }
    const signed = signChallenge({ challenge: wider, key: signingKeyFromPem(node.privateKeyPem).privateKey })
    expect(readChallenge({ signed: signed.signed, nodeKey: publicKeyFrom(node.publicKey) })).toEqual({ challenge: wider, digest: signed.digest })
    expect(signed.digest).not.toBe(challengeBytes(challenge).digest)
    const [, signature] = signed.signed.split('.')
    const widened = Buffer.from(JSON.stringify({ ...wider, widerSubject: 'delete-below:/' })).toString('base64url')
    expect(readChallenge({ signed: `${widened}.${signature}`, nodeKey: publicKeyFrom(node.publicKey) })).toBeNull()
  })

  it('does not verify under another key, altered, or as a signed request of the same bytes', () => {
    const signed = signChallenge({ challenge, key: signingKeyFromPem(node.privateKeyPem).privateKey }).signed
    expect(readChallenge({ signed, nodeKey: publicKeyFrom(owner.publicKey) })).toBeNull()
    const [encoded, signature] = signed.split('.')
    const altered = Buffer.from(JSON.stringify({ ...challenge, subject: 'ls' })).toString('base64url')
    expect(readChallenge({ signed: `${altered}.${signature}`, nodeKey: publicKeyFrom(node.publicKey) })).toBeNull()
    // Owner decision D9: the description a relay rewrites, or a truncation it hides, breaks the node's signature too.
    for (const changed of [{ description: 'Run `ls` in /workspace' }, { truncated: true }, { description: null }]) {
      const rewritten = Buffer.from(JSON.stringify({ ...challenge, ...changed })).toString('base64url')
      expect(readChallenge({ signed: `${rewritten}.${signature}`, nodeKey: publicKeyFrom(node.publicKey) })).toBeNull()
    }
    // Signatures are made under separate contexts: a challenge signature is no request signature.
    const asRequest = verifySignedRequest({ authorization: `5straps-Signed ${encoded}.${signature}`, body: Buffer.alloc(0), now, expected: { purpose: 'buckle-approval', ...route }, publicKeyFor: () => ({ key: publicKeyFrom(node.publicKey), covers: true }), claim: () => true })
    expect(asRequest).toMatchObject({ ok: false })
  })
})

describe('a small-order public key (review L3 of B23-B25)', () => {
  // The eight small-order points as canonical encodings, and two non-canonical ones for the same points.
  const encodings = [
    '0100000000000000000000000000000000000000000000000000000000000000',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0000000000000000000000000000000000000000000000000000000000000080',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  ]

  it('is refused as a key for every one of them, and never for a real key', () => {
    for (const hex of encodings) {
      const text = `ed25519:${Buffer.from(hex, 'hex').toString('base64url')}`
      expect(isSmallOrderPoint(Buffer.from(hex, 'hex'))).toBe(true)
      expect(() => publicKeyFrom(text)).toThrow(SmallOrderKeyError)
      expect(() => keyIdOf(text)).toThrow(SmallOrderKeyError)
    }
    for (let index = 0; index < 50; index++) expect(() => publicKeyFrom(generateSigningKey().publicKey)).not.toThrow()
  })

  // A signature by nobody: R the identity point and S zero. Under the identity key, Node before 24.19
  // verifies it for any message, and 24.19 and later refuse the point themselves. The package refuses
  // the key on every release, so a request carrying this signature is turned away at the key and never
  // reaches a signature check, whichever answer this Node would give.
  it('turns a request forged under the identity key away at the key, before any signature check, on every Node', () => {
    const identity = Buffer.from(encodings[0]!, 'hex')
    const forged = Buffer.concat([identity, Buffer.alloc(32)])
    const identityKey = `ed25519:${identity.toString('base64url')}`
    const keyId = `SHA256:${createHash('sha256').update(identity).digest('base64url')}`
    // This Node's own answer for the forgery, for the failure message only, since it differs by release.
    const nodeVerifies = (() => {
      try {
        return verify(null, Buffer.from('anything'), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: identity.toString('base64url') }, format: 'jwk' }), forged)
      } catch {
        return false
      }
    })()
    const [scheme, token] = signed().split(' ')
    const payload = JSON.parse(Buffer.from(token!.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const header = `${scheme} ${Buffer.from(JSON.stringify({ ...payload, keyId })).toString('base64url')}.${forged.toString('base64url')}`
    const verdict = verifySignedRequest({
      authorization: header, body: Buffer.from(body), now, expected: { purpose: 'buckle-setup', ...route }, claim: () => true,
      // As an enrolled-key store does: a key the package refuses is no enrolled key.
      publicKeyFor: () => {
        try {
          return { key: publicKeyFrom(identityKey), covers: true }
        } catch (error) {
          if (error instanceof SmallOrderKeyError) return { refused: 'unknown_key' }
          throw error
        }
      },
    })
    expect(verdict, `this Node's own verify ${nodeVerifies ? 'accepts' : 'refuses'} the forged signature`).toEqual({ ok: false, reason: 'unknown_key', claimedKeyId: keyId })
  })
})
