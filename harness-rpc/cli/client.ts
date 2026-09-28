import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { generateSigningKey, PublicKeyTextSchema, publicKeyFrom, readChallenge, signingKeyFromPem, signRequest, type ApprovalChallenge, type SignedRequestPurpose, type SigningKey } from '@5straps/protocol/signed-request'

export interface CliResult {
  exitCode: number
}

export const CLIENT_KEY_FILE = 'client-key.pem'
/** The node keys this device pinned, by serverId, as ssh's known_hosts. */
export const TRUSTED_NODES_FILE = 'trusted-nodes.json'
const TrustedNodesSchema = z.object({ version: z.literal(1), nodes: z.record(z.string(), PublicKeyTextSchema) })

const USAGE = `Usage:
  buckle client keygen [--force]      Make this device's signing key; prints the public key to enroll
  buckle client key                   Print this device's public key and its fingerprint
  buckle client request <METHOD> <url> [--body <json>] [--purpose setup|approval] [--node <server-id>] [--session <id>]
                                      Send one request to a node's setup face, signed with this device's key
  buckle client session open <node-url> [--workspace <id>]
  buckle client session close <node-url> <session-id> [--workspace <id>]
                                      A setup session: signed setup changes name it with --session
  buckle client trust <server-id> <node-public-key>
                                      Pin a node's key, as \`buckle keys node\` prints it on that node
  buckle client approvals <node-url> [--workspace <id>]
  buckle client approve <node-url> <token> [--deny] [--scope once|session|always] [--workspace <id>]
                                      Show what an ask is, as the pinned node signed it, and decide on exactly that

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
    if (verb === 'session') return await session(rest, environment)
    if (verb === 'trust') return trust(rest, environment)
    if (verb === 'approvals') return await approvals(rest, environment)
    if (verb === 'approve') return await approve(rest, environment)
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
  const { values, positionals } = parseArgs({ args: argv, options: { body: { type: 'string' }, purpose: { type: 'string' }, node: { type: 'string' }, session: { type: 'string' } }, allowPositionals: true })
  const [method, target] = positionals
  if (!method || !target || positionals.length !== 2) throw new ClientError(USAGE)
  const url = new URL(target)
  const response = await send({ environment, method, url, body: values.body ?? '', purpose: purposeOf(values.purpose, url.pathname), ...(values.node ? { node: values.node } : {}), ...(values.session ? { session: values.session } : {}) })
  return report(response, await response.text())
}

/** Sends one request, signed with this device's key for the node, workspace, method, path and exact body. */
async function send(input: { environment: NodeJS.ProcessEnv; method: string; url: URL; body: string; purpose: SignedRequestPurpose; node?: string; session?: string }): Promise<Response> {
  const method = input.method.toUpperCase()
  const workspace = decodeURIComponent(/^\/workspaces\/([^/]+)\//.exec(input.url.pathname)?.[1] ?? 'default')
  const authorization = signRequest({
    key: loadClientKey(input.environment), purpose: input.purpose, node: input.node ?? await serverIdOf(input.url), workspace,
    method, path: `${input.url.pathname}${input.url.search}`, body: input.body, ...(input.session ? { session: input.session } : {}),
  })
  return fetch(input.url, { method, headers: { authorization, ...(input.body ? { 'content-type': 'application/json' } : {}) }, ...(input.body ? { body: input.body } : {}), signal: AbortSignal.timeout(30_000) })
}

function report(response: Response, text: string): CliResult {
  process.stderr.write(`HTTP ${response.status}\n`)
  if (text) process.stdout.write(`${text}\n`)
  return { exitCode: response.ok ? 0 : 1 }
}

/** A node URL and an optional workspace as the route for one of its setup paths. */
function setupUrl(node: string, workspace: string | undefined, path: string): URL {
  const prefix = workspace && workspace !== 'default' ? `/workspaces/${encodeURIComponent(workspace)}` : ''
  return new URL(`${prefix}/setup/${path}`, new URL(node).origin)
}

async function session(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' } }, allowPositionals: true })
  const [action, node, id] = positionals
  if (action === 'open' && node && positionals.length === 2) {
    const response = await send({ environment, method: 'POST', url: setupUrl(node, values.workspace, 'sessions'), body: '', purpose: 'buckle-setup' })
    const text = await response.text()
    if (response.ok) process.stdout.write(`${(JSON.parse(text) as { session: { id: string } }).session.id}\n`)
    else process.stderr.write(`HTTP ${response.status} ${text}\n`)
    return { exitCode: response.ok ? 0 : 1 }
  }
  if (action === 'close' && node && id && positionals.length === 3) {
    const response = await send({ environment, method: 'DELETE', url: setupUrl(node, values.workspace, `sessions/${encodeURIComponent(id)}`), body: '', purpose: 'buckle-setup', session: id })
    return report(response, await response.text())
  }
  throw new ClientError(USAGE)
}

function trust(argv: string[], environment: NodeJS.ProcessEnv): CliResult {
  const [serverId, publicKey] = argv
  if (!serverId || !publicKey || argv.length !== 2) throw new ClientError(USAGE)
  try {
    publicKeyFrom(publicKey)
  } catch {
    throw new ClientError('Not a node key: pass the Public key line `buckle keys node` prints on the node itself')
  }
  const file = join(clientDirectory(environment), TRUSTED_NODES_FILE)
  const trusted = trustedNodes(environment)
  trusted.nodes[serverId] = publicKey
  mkdirSync(clientDirectory(environment), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(trusted, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
  process.stdout.write(`Pinned ${serverId}'s key; challenges from it are shown only when that key signed them.\n`)
  return { exitCode: 0 }
}

function trustedNodes(environment: NodeJS.ProcessEnv): z.infer<typeof TrustedNodesSchema> {
  const file = join(clientDirectory(environment), TRUSTED_NODES_FILE)
  if (!existsSync(file)) return { version: 1, nodes: {} }
  return TrustedNodesSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

/** The node's waiting asks, each verified with the key pinned for it; one that does not verify is never shown. */
async function verifiedChallenges(input: { environment: NodeJS.ProcessEnv; node: string; workspace: string | undefined }): Promise<{ serverId: string; challenges: Array<{ token: string; challenge: ApprovalChallenge; digest: string }> }> {
  const url = setupUrl(input.node, input.workspace, 'approvals/challenges')
  const serverId = await serverIdOf(url)
  const pinned = trustedNodes(input.environment).nodes[serverId]
  if (!pinned) throw new ClientError(`${serverId} is not pinned on this device: run buckle keys node on it, then buckle client trust ${serverId} <its public key>`)
  const response = await send({ environment: input.environment, method: 'GET', url, body: '', purpose: 'buckle-approval', node: serverId })
  if (!response.ok) throw new ClientError(`The node answered HTTP ${response.status}`)
  const body = await response.json() as { challenges?: Array<{ token: string; signed: string }> }
  const nodeKey = publicKeyFrom(pinned)
  const challenges = (body.challenges ?? []).flatMap((item) => {
    const read = readChallenge({ signed: item.signed, nodeKey })
    return read && read.challenge.node === serverId && read.challenge.token === item.token ? [{ token: item.token, ...read }] : []
  })
  return { serverId, challenges }
}

/** The raw action from the verified challenge, and nothing a relay described. */
function describeChallenge(challenge: ApprovalChallenge): string {
  return [
    `${challenge.token}  ${challenge.tool} asks ${challenge.rule}`,
    `  subject:  ${challenge.subject}`,
    `  reason:   ${challenge.reason}`,
    `  scopes:   ${challenge.offeredScopes.join(', ')}; expires ${challenge.expiresAt}`,
    `  call:     ${challenge.callDigest ?? 'not recorded'}; workspace ${challenge.workspace}, session ${challenge.sessionId}`,
  ].join('\n')
}

async function approvals(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' } }, allowPositionals: true })
  const [node] = positionals
  if (!node || positionals.length !== 1) throw new ClientError(USAGE)
  const { challenges } = await verifiedChallenges({ environment, node, workspace: values.workspace })
  process.stdout.write(challenges.length === 0 ? 'Nothing is waiting for approval.\n' : `${challenges.map(item => describeChallenge(item.challenge)).join('\n')}\n`)
  return { exitCode: 0 }
}

async function approve(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' }, deny: { type: 'boolean' }, scope: { type: 'string' } }, allowPositionals: true })
  const [node, token] = positionals
  if (!node || !token || positionals.length !== 2) throw new ClientError(USAGE)
  const scope = values.scope ?? 'once'
  if (scope !== 'once' && scope !== 'session' && scope !== 'always') throw new ClientError('--scope takes once, session or always')
  const { serverId, challenges } = await verifiedChallenges({ environment, node, workspace: values.workspace })
  const found = challenges.find(item => item.token === token)
  if (!found) throw new ClientError(`No waiting ask ${token} that ${serverId}'s pinned key signed`)
  process.stdout.write(`${describeChallenge(found.challenge)}\n`)
  const body = JSON.stringify({ token, approved: !values.deny, scope, challenge: found.digest })
  const response = await send({ environment, method: 'POST', url: setupUrl(node, values.workspace, 'approvals'), body, purpose: 'buckle-approval', node: serverId })
  return report(response, await response.text())
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
