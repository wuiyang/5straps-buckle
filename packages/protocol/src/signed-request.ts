import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'

/**
 * Proof of possession for Buckle's setup and approval routes (owner ruling H4 of 2026-09-28): the
 * person's client holds an Ed25519 private key, Buckle enrolls its public key locally, and each
 * request is signed as it is sent. The signature covers the exact payload bytes; the payload binds
 * the purpose and version, the node and workspace, the method and path, a sha256 of the exact body,
 * a nonce, when it was issued and when it expires, and the key. A relay carries the Authorization
 * header and the body as they are and never holds a private key. Imported by path
 * (`@5straps/protocol/signed-request`) because it needs node:crypto.
 */
export const SIGNED_REQUEST_VERSION = 1
/** `Authorization: 5straps-Signed <payload>.<signature>`, both base64url. */
export const SIGNED_REQUEST_SCHEME = '5straps-Signed'
/** A signed request is good for at most this long after it was issued. */
export const SIGNED_REQUEST_MAX_TTL_MS = 60_000
/** How far the signer's clock may be off the verifier's, either way. */
export const SIGNED_REQUEST_SKEW_MS = 30_000

const PUBLIC_KEY_PREFIX = 'ed25519:'
const NONCE_BYTES = 16
const SIGNATURE_BYTES = 64
const MAX_HEADER_LENGTH = 8_192
/** Each signature is made over its own context, so one kind of signature never verifies as another. */
const REQUEST_CONTEXT = '5straps/signed-request/v1\0'

/** An enrolled key's name and fingerprint: `SHA256:` and the base64url sha256 of its raw public key. */
export const KeyIdSchema = z.string().regex(/^SHA256:[A-Za-z0-9_-]{43}$/)
/** A public key as it is shown and enrolled: `ed25519:` and its 32 raw bytes in base64url. */
export const PublicKeyTextSchema = z.string().regex(/^ed25519:[A-Za-z0-9_-]{43}$/)

/** What the request is for: a setup change, or an approval decision. A signature for one never serves the other. */
export const SignedRequestPurposeSchema = z.enum(['buckle-setup', 'buckle-approval'])
export type SignedRequestPurpose = z.infer<typeof SignedRequestPurposeSchema>

export const SignedRequestPayloadSchema = z.object({
  v: z.literal(SIGNED_REQUEST_VERSION),
  purpose: SignedRequestPurposeSchema,
  /** The Buckle node's serverId. */
  node: z.string().min(1).max(200),
  workspace: z.string().min(1).max(64),
  method: z.string().regex(/^[A-Z]{1,16}$/),
  /** The path and query as requested. */
  path: z.string().regex(/^\/[^\s]*$/).max(2_048),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  keyId: KeyIdSchema,
}).strict()
export type SignedRequestPayload = z.infer<typeof SignedRequestPayloadSchema>

/** Why a signed request was refused. The verifier's owner logs it; the caller is told only 401. */
export type SignedRequestRefusal = 'malformed' | 'wrong_purpose' | 'wrong_target' | 'expired' | 'unknown_key' | 'bad_signature' | 'body_mismatch' | 'replayed'

export type SignedRequestVerdict = { ok: true; payload: SignedRequestPayload } | { ok: false; reason: SignedRequestRefusal }

/** A private key and the name its public half is enrolled under. */
export interface SigningKey {
  keyId: string
  privateKey: KeyObject
}

/** A fresh key pair: the private half as PKCS#8 PEM to keep owner-only, the public half as enrolled. */
export function generateSigningKey(): { privateKeyPem: string; publicKey: string; keyId: string } {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = publicKeyText(pair.publicKey)
  return { privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey, keyId: keyIdOf(publicKey) }
}

/** A private key read back from its PEM, with the name of its public half. Throws on anything but Ed25519. */
export function signingKeyFromPem(pem: string): SigningKey & { publicKey: string } {
  const privateKey = createPrivateKey(pem)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('A signing key must be Ed25519')
  const publicKey = publicKeyText(createPublicKey(privateKey))
  return { keyId: keyIdOf(publicKey), privateKey, publicKey }
}

export function publicKeyText(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' })
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('A public key must be Ed25519')
  return `${PUBLIC_KEY_PREFIX}${jwk.x}`
}

/** The key object for an enrolled public key. Throws when the text is not an Ed25519 public key. */
export function publicKeyFrom(text: string): KeyObject {
  if (!PublicKeyTextSchema.safeParse(text).success) throw new Error('A public key is ed25519: followed by 32 bytes in base64url')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: text.slice(PUBLIC_KEY_PREFIX.length) }, format: 'jwk' })
}

export function keyIdOf(publicKey: string): string {
  const raw = Buffer.from(publicKeyFrom(publicKey).export({ format: 'jwk' }).x!, 'base64url')
  return `SHA256:${createHash('sha256').update(raw).digest('base64url')}`
}

/** The sha256 of a body exactly as it travels; an absent body is the empty one. */
export function bodyDigest(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex')
}

/** Signs `bytes` under a context, so a signature made for one purpose never verifies for another. */
export function signBytes(input: { context: string; bytes: Uint8Array; key: KeyObject }): Buffer {
  return sign(null, Buffer.concat([Buffer.from(input.context, 'utf8'), input.bytes]), input.key)
}

export function verifyBytes(input: { context: string; bytes: Uint8Array; signature: Uint8Array; key: KeyObject }): boolean {
  if (input.signature.length !== SIGNATURE_BYTES) return false
  try {
    return verify(null, Buffer.concat([Buffer.from(input.context, 'utf8'), input.bytes]), input.key, input.signature)
  } catch {
    return false
  }
}

/** The Authorization header value for one request: its payload, signed with the client's key. */
export function signRequest(input: {
  key: SigningKey
  purpose: SignedRequestPurpose
  node: string
  workspace: string
  method: string
  path: string
  body: Uint8Array | string
  now?: number
  ttlMs?: number
}): string {
  const issuedAt = input.now ?? Date.now()
  const payload: SignedRequestPayload = SignedRequestPayloadSchema.parse({
    v: SIGNED_REQUEST_VERSION, purpose: input.purpose, node: input.node, workspace: input.workspace,
    method: input.method.toUpperCase(), path: input.path, bodySha256: bodyDigest(input.body),
    nonce: randomBytes(NONCE_BYTES).toString('base64url'), issuedAt,
    expiresAt: issuedAt + Math.min(input.ttlMs ?? SIGNED_REQUEST_MAX_TTL_MS, SIGNED_REQUEST_MAX_TTL_MS), keyId: input.key.keyId,
  })
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = signBytes({ context: REQUEST_CONTEXT, bytes, key: input.key.privateKey })
  return `${SIGNED_REQUEST_SCHEME} ${bytes.toString('base64url')}.${signature.toString('base64url')}`
}

/** Whether an Authorization header claims to be a signed request, so it is judged as one and never as a bearer credential. */
export function isSignedRequest(authorization: string | undefined): boolean {
  return authorization?.startsWith(`${SIGNED_REQUEST_SCHEME} `) === true
}

/**
 * Verifies one signed request against what the verifier received. Cheap checks come first; the key's
 * signature before the body; the nonce is claimed last, so a forged or mismatched request never
 * spends a genuine nonce. `claim` answers false for a nonce already seen, and keeps it until `keepUntil`.
 */
export function verifySignedRequest(input: {
  authorization: string | undefined
  expected: { purpose: SignedRequestPurpose; node: string; workspace: string; method: string; path: string }
  body: Uint8Array
  now: number
  publicKeyFor: (keyId: string) => KeyObject | null
  claim: (input: { keyId: string; nonce: string; keepUntil: number }) => boolean
}): SignedRequestVerdict {
  const read = readSignedRequest(input.authorization)
  if (!read) return { ok: false, reason: 'malformed' }
  const { payload, bytes, signature } = read
  const { expected } = input
  if (payload.purpose !== expected.purpose) return { ok: false, reason: 'wrong_purpose' }
  if (payload.node !== expected.node || payload.workspace !== expected.workspace || payload.method !== expected.method.toUpperCase() || payload.path !== expected.path) return { ok: false, reason: 'wrong_target' }
  if (!withinWindow(payload, input.now)) return { ok: false, reason: 'expired' }
  const key = input.publicKeyFor(payload.keyId)
  if (!key) return { ok: false, reason: 'unknown_key' }
  if (!verifyBytes({ context: REQUEST_CONTEXT, bytes, signature, key })) return { ok: false, reason: 'bad_signature' }
  if (bodyDigest(input.body) !== payload.bodySha256) return { ok: false, reason: 'body_mismatch' }
  if (!input.claim({ keyId: payload.keyId, nonce: payload.nonce, keepUntil: payload.expiresAt + SIGNED_REQUEST_SKEW_MS })) return { ok: false, reason: 'replayed' }
  return { ok: true, payload }
}

/** Issued no later than the skew ahead of now, not expired beyond the skew, and never good for longer than the maximum. */
export function withinWindow(payload: { issuedAt: number; expiresAt: number }, now: number): boolean {
  return payload.expiresAt > payload.issuedAt
    && payload.expiresAt - payload.issuedAt <= SIGNED_REQUEST_MAX_TTL_MS
    && payload.issuedAt - SIGNED_REQUEST_SKEW_MS <= now
    && now <= payload.expiresAt + SIGNED_REQUEST_SKEW_MS
}

function readSignedRequest(authorization: string | undefined): { payload: SignedRequestPayload; bytes: Buffer; signature: Buffer } | null {
  if (!isSignedRequest(authorization) || authorization!.length > MAX_HEADER_LENGTH) return null
  const [encodedPayload, encodedSignature, ...rest] = authorization!.slice(SIGNED_REQUEST_SCHEME.length + 1).split('.')
  if (!encodedPayload || !encodedSignature || rest.length > 0 || !/^[A-Za-z0-9_-]+$/.test(encodedPayload + encodedSignature)) return null
  const bytes = Buffer.from(encodedPayload, 'base64url')
  const signature = Buffer.from(encodedSignature, 'base64url')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  const payload = SignedRequestPayloadSchema.safeParse(parsed)
  return payload.success ? { payload: payload.data, bytes, signature } : null
}
