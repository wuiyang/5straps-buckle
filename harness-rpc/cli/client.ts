import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { printable } from '../common/domain/approval-instruction.js'
import { callDigestOf, generateSigningKey, keyIdOf, PublicKeyTextSchema, publicKeyFrom, readChallenge, signingKeyFromPem, signRequest, SmallOrderKeyError, type ApprovalChallenge, type SignedRequestPurpose, type SigningKey } from '@5straps/protocol/signed-request'

export interface CliResult {
  exitCode: number
}

export const CLIENT_KEY_FILE = 'client-key.pem'
/**
 * The nodes this device pinned, as ssh's known_hosts: by the URL the person types (its origin), the
 * node's serverId and its signing key (owner decision D11). A request is signed only for a pinned node.
 */
export const TRUSTED_NODES_FILE = 'trusted-nodes.json'
const PinSchema = z.object({ serverId: z.string().min(1).max(200), publicKey: PublicKeyTextSchema })
const TrustedNodesSchema = z.object({ version: z.literal(2), nodes: z.record(z.string(), PinSchema) })
type Pin = z.infer<typeof PinSchema>

const USAGE = `Usage:
  buckle client keygen [--force]      Make this device's signing key; prints the public key to enroll
  buckle client key                   Print this device's public key and its fingerprint
  buckle client request <METHOD> <url> [--body <json>] [--purpose setup|approval] [--node <server-id>] [--session <id>]
                                      Send one request to a pinned node's setup face, signed with this device's key;
                                      --node, when given, must name the node pinned for the URL
  buckle client session open <node-url> [--workspace <id>]
  buckle client session close <node-url> <session-id> [--workspace <id>]
                                      A setup session: signed setup changes name it with --session
  buckle client trust <node-url> <server-id> <node-public-key>
                                      Pin the node at that URL, as \`buckle keys node\` prints it on that node
  buckle client approvals <node-url> [--workspace <id>]
  buckle client approve <node-url> <token> [--deny] [--scope once|session|always] [--workspace <id>] [--accept-truncated]
                                      Show what an ask is, as the pinned node signed it, and decide on exactly that;
                                      an ask whose arguments the node had to cut is signed only with --accept-truncated

The key and the pinned nodes live in BUCKLE_CLIENT_DIR (an absolute path), ~/.5straps/client by default, owner-only.
A request is signed only for the node pinned for the URL typed, never for what the URL says it is.`

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
  return `Public key:  ${key.publicKey}\nFingerprint: ${key.keyId}\nOn the node: buckle keys enroll ${key.publicKey} --purpose setup|approval|both --workspace <id>|node --label <this device>\n`
}

async function request(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { body: { type: 'string' }, purpose: { type: 'string' }, node: { type: 'string' }, session: { type: 'string' } }, allowPositionals: true })
  const [method, target] = positionals
  if (!method || !target || positionals.length !== 2) throw new ClientError(USAGE)
  const url = new URL(target)
  const response = await send({ environment, method, url, body: values.body ?? '', purpose: purposeOf(values.purpose, url.pathname), ...(values.node ? { node: values.node } : {}), ...(values.session ? { session: values.session } : {}) })
  return report(response, await response.text())
}

/**
 * Sends one request, signed with this device's key for the node pinned for the URL (its serverId and
 * its key's fingerprint), the workspace, method, path and exact body. An unpinned URL, or a --node
 * that is not the pinned one, signs nothing.
 */
async function send(input: { environment: NodeJS.ProcessEnv; method: string; url: URL; body: string; purpose: SignedRequestPurpose; node?: string; session?: string }): Promise<Response> {
  const method = input.method.toUpperCase()
  const workspace = decodeURIComponent(/^\/workspaces\/([^/]+)\//.exec(input.url.pathname)?.[1] ?? 'default')
  const pin = pinFor(input.environment, input.url)
  if (input.node !== undefined && input.node !== pin.serverId) throw new ClientError(`--node names ${input.node}, but ${input.url.origin} is pinned as ${pin.serverId}; nothing was signed`)
  const authorization = signRequest({
    key: loadClientKey(input.environment), purpose: input.purpose, node: pin.serverId, nodeKey: keyIdOf(pin.publicKey), workspace,
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
  const [node, serverId, publicKey] = argv
  if (!node || !serverId || !publicKey || argv.length !== 3) throw new ClientError(USAGE)
  const origin = originOf(node)
  try {
    publicKeyFrom(publicKey)
  } catch (error) {
    if (error instanceof SmallOrderKeyError) throw new ClientError(`Not pinned: ${error.message}`)
    throw new ClientError('Not a node key: pass the Public key line `buckle keys node` prints on the node itself')
  }
  const file = join(clientDirectory(environment), TRUSTED_NODES_FILE)
  const trusted = trustedNodes(environment)
  trusted.nodes[origin] = { serverId, publicKey }
  mkdirSync(clientDirectory(environment), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(trusted, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
  process.stdout.write(`Pinned ${origin} as ${serverId} (${keyIdOf(publicKey)}); requests to it are signed for that node only, and its challenges are shown only when that key signed them.\n`)
  return { exitCode: 0 }
}

function trustedNodes(environment: NodeJS.ProcessEnv): z.infer<typeof TrustedNodesSchema> {
  const file = join(clientDirectory(environment), TRUSTED_NODES_FILE)
  if (!existsSync(file)) return { version: 2, nodes: {} }
  const parsed = TrustedNodesSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) throw new ClientError(`${file} is not a pin list this client reads (pins are now kept by node URL); move it aside and pin each node again with buckle client trust <node-url> <server-id> <node-public-key>`)
  return parsed.data
}

/** The node pinned for a URL's origin; never what the URL itself says it is (owner decision D11). */
function pinFor(environment: NodeJS.ProcessEnv, url: URL): Pin {
  const pin = trustedNodes(environment).nodes[url.origin]
  if (!pin) throw new ClientError(`${url.origin} is not pinned on this device: run buckle keys node on that node, then buckle client trust ${url.origin} <its server id> <its public key>`)
  return pin
}

function originOf(node: string): string {
  try {
    return new URL(node).origin
  } catch {
    throw new ClientError(`Not a node URL: ${node}`)
  }
}

interface VerifiedChallenge {
  token: string
  challenge: ApprovalChallenge
  digest: string
  /** Whether the call digest recomputes from the arguments the challenge shows (owner decision D9). */
  consistent: boolean
}

/** An ask the node listed without a signed challenge, with the node's reason; never decidable from a device. */
interface UnsignedAsk { token: string; error: string }

/**
 * The node's waiting asks, each verified with the key pinned for the URL; one that does not verify is
 * never shown. An ask the node could not sign comes back as its token and the node's reason, so one bad
 * ask never hides the others (review M3 of the second proof-of-possession re-review).
 */
async function verifiedChallenges(input: { environment: NodeJS.ProcessEnv; node: string; workspace: string | undefined }): Promise<{ pin: Pin; origin: string; challenges: VerifiedChallenge[]; unsigned: UnsignedAsk[] }> {
  const url = setupUrl(input.node, input.workspace, 'approvals/challenges')
  const pin = pinFor(input.environment, url)
  const response = await send({ environment: input.environment, method: 'GET', url, body: '', purpose: 'buckle-approval' })
  if (!response.ok) throw new ClientError(`The node answered HTTP ${response.status}`)
  const body = await response.json() as { challenges?: Array<{ token: string; signed?: unknown; error?: unknown }> }
  const nodeKey = publicKeyFrom(pin.publicKey)
  const listed = body.challenges ?? []
  const challenges = listed.flatMap((item) => {
    if (typeof item.signed !== 'string') return []
    const read = readChallenge({ signed: item.signed, nodeKey })
    if (!read || read.challenge.node !== pin.serverId || read.challenge.token !== item.token) return []
    return [{ token: item.token, ...read, consistent: recomputes(read.challenge) }]
  })
  const unsigned = listed.flatMap(item => typeof item.signed !== 'string' && typeof item.token === 'string' && typeof item.error === 'string' ? [{ token: item.token, error: item.error }] : [])
  return { pin, origin: url.origin, challenges, unsigned }
}

/** An ask listed without a challenge: its token and the node's reason, unverified, so escaped like every field. */
function describeUnsigned(item: UnsignedAsk): string {
  return `${printable(item.token)}  not signed by the node: ${printable(item.error)}`
}

/** The call digest recomputed from the arguments shown; a challenge without them shows no action to decide on. */
function recomputes(challenge: ApprovalChallenge): boolean {
  return challenge.arguments !== null && challenge.callDigest === callDigestOf({ tool: challenge.tool, arguments: challenge.arguments })
}

/**
 * The node's description, then the raw action, from the verified challenge and nothing a relay
 * described. Every field is agent-influenced, so each passes through printable(), and the arguments
 * are printed as JSON with every unprintable character escaped: nothing in a challenge can move the
 * cursor, reorder a line or hide text before a person signs (review item 2 of the proof-of-possession fixes).
 */
function describeChallenge(item: VerifiedChallenge): string {
  const { challenge } = item
  const shown = challenge.arguments === null ? ['  arguments: not recorded'] : ['  arguments:', ...JSON.stringify(challenge.arguments, null, 2).split('\n').map(line => `    ${printable(line)}`)]
  return [
    `${printable(challenge.token)}  ${printable(challenge.tool)} asks ${printable(challenge.rule)}`,
    `  does:     ${challenge.description === null ? 'not described' : printable(challenge.description)}`,
    `  subject:  ${printable(challenge.subject)}`,
    `  reason:   ${printable(challenge.reason)}`,
    `  in:       ${challenge.cwd === null ? 'not recorded' : printable(challenge.cwd)}`,
    ...shown,
    `  scopes:   ${challenge.offeredScopes.join(', ')}; expires ${printable(challenge.expiresAt)}`,
    `  call:     ${challenge.callDigest ?? 'not recorded'}; workspace ${printable(challenge.workspace)}, session ${printable(challenge.sessionId)}`,
    ...(challenge.truncated ? [`  WARNING: the node cut part of this call's arguments or description to fit (a string shown as its head, length and sha256, the whole call as its size and sha256, or a fact or the description cut with its length named); approve refuses it without --accept-truncated`] : []),
    ...(item.consistent ? [] : ['  WARNING: the arguments shown do not match the call digest; approve refuses this ask']),
  ].join('\n')
}

async function approvals(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' } }, allowPositionals: true })
  const [node] = positionals
  if (!node || positionals.length !== 1) throw new ClientError(USAGE)
  const { challenges, unsigned } = await verifiedChallenges({ environment, node, workspace: values.workspace })
  const shown = [...challenges.map(describeChallenge), ...unsigned.map(describeUnsigned)]
  process.stdout.write(shown.length === 0 ? 'Nothing is waiting for approval.\n' : `${shown.join('\n')}\n`)
  return { exitCode: 0 }
}

async function approve(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' }, deny: { type: 'boolean' }, scope: { type: 'string' }, 'accept-truncated': { type: 'boolean' } }, allowPositionals: true })
  const [node, token] = positionals
  if (!node || !token || positionals.length !== 2) throw new ClientError(USAGE)
  const scope = values.scope ?? 'once'
  if (scope !== 'once' && scope !== 'session' && scope !== 'always') throw new ClientError('--scope takes once, session or always')
  const { pin, origin, challenges, unsigned } = await verifiedChallenges({ environment, node, workspace: values.workspace })
  const found = challenges.find(item => item.token === token)
  const refused = unsigned.find(item => item.token === token)
  if (!found && refused) throw new ClientError(`${describeUnsigned(refused)}; nothing was signed`)
  if (!found) throw new ClientError(`No waiting ask ${printable(token)} that ${printable(pin.serverId)}'s pinned key signed`)
  process.stdout.write(`Node:  ${printable(pin.serverId)}  ${keyIdOf(pin.publicKey)}  at ${printable(origin)}\n${describeChallenge(found)}\n`)
  if (!found.consistent) throw new ClientError(`The arguments ${printable(pin.serverId)} shows for ${printable(token)} do not recompute to its call digest; nothing was signed`)
  // D9: the raw action must be seen whole; a cut one is signed only when the person says so (review item 7).
  if (found.challenge.truncated && values['accept-truncated'] !== true) throw new ClientError(`${printable(pin.serverId)} could show ${printable(token)} only in part, so nothing was signed; review the call another way, then pass --accept-truncated to decide on it as shown`)
  const body = JSON.stringify({ token, approved: !values.deny, scope, challenge: found.digest })
  const response = await send({ environment, method: 'POST', url: setupUrl(node, values.workspace, 'approvals'), body, purpose: 'buckle-approval', node: pin.serverId })
  return report(response, await response.text())
}

/** An approval route takes an approval signature; every other setup route a setup one. */
function purposeOf(named: string | undefined, pathname: string): SignedRequestPurpose {
  if (named === 'setup') return 'buckle-setup'
  if (named === 'approval') return 'buckle-approval'
  if (named !== undefined) throw new ClientError('--purpose takes setup or approval')
  return /\/setup\/approvals(?:\/|$)/.test(pathname) ? 'buckle-approval' : 'buckle-setup'
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
