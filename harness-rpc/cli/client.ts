import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { generateSigningKey, signingKeyFromPem, signRequest, type SignedRequestPurpose, type SigningKey } from '@5straps/protocol/signed-request'

export interface CliResult {
  exitCode: number
}

export const CLIENT_KEY_FILE = 'client-key.pem'

const USAGE = `Usage:
  buckle client keygen [--force]      Make this device's signing key; prints the public key to enroll
  buckle client key                   Print this device's public key and its fingerprint
  buckle client request <METHOD> <url> [--body <json>] [--purpose setup|approval] [--node <server-id>]
                                      Send one request to a node's setup face, signed with this device's key

The key lives in BUCKLE_CLIENT_DIR (an absolute path), ~/.5straps/client by default, owner-only.`

/**
 * The person's side of proof of possession (owner ruling H4 of 2026-09-28): this device keeps its
 * Ed25519 private key, owner-only, in its own directory, and signs each request as it sends it. It
 * never needs the node's settings, and no private key leaves it: a node, or Rings relaying for one,
 * only ever sees the public key and signatures.
 */
export async function clientCommand(argv: string[], environment: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const [verb, ...rest] = argv
  try {
    if (verb === 'keygen') return keygen(rest, environment)
    if (verb === 'key') return showKey(environment)
    if (verb === 'request') return await request(rest, environment)
  } catch (error) {
    if (error instanceof ClientError) return fail(error.message)
    throw error
  }
  return fail(USAGE)
}

/** Where this device keeps its key: BUCKLE_CLIENT_DIR when set, which must be absolute, or ~/.5straps/client. */
export function clientDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const named = environment.BUCKLE_CLIENT_DIR
  if (!named) return join(homedir(), '.5straps', 'client')
  if (!isAbsolute(named)) throw new ClientError(`BUCKLE_CLIENT_DIR must be an absolute path, not ${named}`)
  return named
}

/** This device's key, refused when other users can read it, as ssh refuses an unprotected key. */
export function loadClientKey(environment: NodeJS.ProcessEnv = process.env): SigningKey & { publicKey: string } {
  const file = join(clientDirectory(environment), CLIENT_KEY_FILE)
  if (!existsSync(file)) throw new ClientError(`No signing key at ${file}: run buckle client keygen first`)
  if ((statSync(file).mode & 0o077) !== 0) throw new ClientError(`${file} can be read by other users; run chmod 600 ${file}`)
  return signingKeyFromPem(readFileSync(file, 'utf8'))
}

class ClientError extends Error {}

function keygen(argv: string[], environment: NodeJS.ProcessEnv): CliResult {
  const { values } = parseArgs({ args: argv, options: { force: { type: 'boolean' } }, allowPositionals: false })
  const directory = clientDirectory(environment)
  const file = join(directory, CLIENT_KEY_FILE)
  if (existsSync(file) && !values.force) throw new ClientError(`${file} already holds this device's key; pass --force to replace it, then enroll the new one and revoke the old`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const generated = generateSigningKey()
  // Written owner-only beside the file, then moved over it, so no reader ever sees half a key.
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, generated.privateKeyPem, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
  process.stdout.write(`Wrote this device's signing key to ${file} (owner-only).\n${describe(generated)}`)
  return { exitCode: 0 }
}

function showKey(environment: NodeJS.ProcessEnv): CliResult {
  process.stdout.write(describe(loadClientKey(environment)))
  return { exitCode: 0 }
}

function describe(key: { publicKey: string; keyId: string }): string {
  return `Public key:  ${key.publicKey}\nFingerprint: ${key.keyId}\nOn the node: buckle keys enroll ${key.publicKey} --label <this device>\n`
}

async function request(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { body: { type: 'string' }, purpose: { type: 'string' }, node: { type: 'string' } }, allowPositionals: true })
  const [method, target] = positionals
  if (!method || !target || positionals.length !== 2) throw new ClientError(USAGE)
  const url = new URL(target)
  const key = loadClientKey(environment)
  const body = values.body ?? ''
  const path = `${url.pathname}${url.search}`
  const workspace = /^\/workspaces\/([^/]+)\//.exec(url.pathname)?.[1] ?? 'default'
  const authorization = signRequest({
    key, purpose: purposeOf(values.purpose, url.pathname), node: values.node ?? await serverIdOf(url), workspace: decodeURIComponent(workspace),
    method: method.toUpperCase(), path, body,
  })
  const response = await fetch(url, { method: method.toUpperCase(), headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000) })
  process.stderr.write(`HTTP ${response.status}\n`)
  process.stdout.write(`${await response.text()}\n`)
  return { exitCode: response.ok ? 0 : 1 }
}

/** An approval route takes an approval signature; every other setup route a setup one. */
function purposeOf(named: string | undefined, pathname: string): SignedRequestPurpose {
  if (named === 'setup') return 'buckle-setup'
  if (named === 'approval') return 'buckle-approval'
  if (named !== undefined) throw new ClientError('--purpose takes setup or approval')
  return /\/setup\/approvals(?:\/|$)/.test(pathname) ? 'buckle-approval' : 'buckle-setup'
}

/** The node's serverId from its open liveness route; pass --node to pin it instead. */
async function serverIdOf(url: URL): Promise<string> {
  const response = await fetch(new URL('/health', url.origin), { signal: AbortSignal.timeout(10_000) })
  const health = await response.json().catch(() => null) as { serverId?: unknown } | null
  if (typeof health?.serverId !== 'string') throw new ClientError(`${url.origin}/health named no serverId; pass --node <server-id>`)
  return health.serverId
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
