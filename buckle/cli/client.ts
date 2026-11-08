import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'pathe'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { terminalConfirm, type Confirm } from './terminal-consumer.js'
import { OwnerOnlyError, requireOwnerOnly, setMode, type OwnerOnlyCheck } from '../common/adapters/file-modes.js'
import { describeAction, printable, sameCallNote, workspaceLabel } from '../common/domain/approval-instruction.js'
import { callDigestOf, ShownApprovalCallSchema, shownCallDigestOf, generateSigningKey, keyIdOf, PublicKeyTextSchema, publicKeyFrom, readChallenge, signingKeyFromPem, signRequest, SIGNED_WORKSPACE_MAX, SmallOrderKeyError, type ApprovalChallenge, type ShownApprovalCall, type SignedRequestPurpose, type SigningKey } from '@5straps/protocol/signed-request'
import { homeDirectory, isDriveRoot, typedPath, WHOLE_DRIVE } from '../common/domain/paths.js'
import { realPathOf } from '../common/runtime/real-path.js'
import { saveEndingLine, unsavedApproval, unsavedDenial } from '../common/adapters/approval/grant-save-question.js'
import { SAVE_FAILED_EXIT } from './exit-codes.js'
import { stoppedForNodeRecord } from './ignore-warning.js'
import { OWNER_RECORD_UNAVAILABLE } from '../common/adapters/action-log/file-action-log.js'
import { IGNORE_WARNING_QUERY } from '../common/domain/global-flags.js'

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
  buckle client session open <node-url> [--workspace <name>]
  buckle client session close <node-url> <session-id> [--workspace <name>]
                                      A setup session: signed setup changes name it with --session
  buckle client trust <node-url> <server-id> <node-public-key>
                                      Pin the node at that URL, as \`buckle keys node\` prints it on that node
  buckle client approvals <node-url> --workspace <name>
  buckle client approve <node-url> <token> [--deny] [--scope once|session|always] --workspace <name>
                                      Show the whole action an ask is, as the pinned node signed it, and decide on exactly that

--ignore-warning asks the node to make a change its audit log cannot record (ignoreWarning=true in the signed query);
without it the node refuses the change, 503, and the command prints the write's error and exits 6.

The key and the pinned nodes live in BUCKLE_CLIENT_DIR (an absolute path), ~/.5straps/client by default, owner-only.
A request is signed only for the node pinned for the URL typed, never for what the URL says it is.`

/**
 * The person's side of proof of possession (owner ruling H4 of 2026-09-28): this device keeps its
 * Ed25519 private key, owner-only, in its own directory, and signs each request as it sends it. It
 * never needs the node's settings, and no private key leaves it: a node, or Rings relaying for one,
 * only ever sees the public key and signatures.
 */
export async function clientCommand(argv: string[], environment: NodeJS.ProcessEnv = process.env, options: { confirm?: Confirm | null; ignoreWarning?: boolean } = {}): Promise<CliResult> {
  const [verb, ...rest] = argv
  const ignoreWarning = options.ignoreWarning === true
  try {
    if (verb === 'keygen') return keygen(rest, environment)
    if (verb === 'key') return showKey(environment)
    if (verb === 'request') return await request(rest, environment, ignoreWarning)
    if (verb === 'session') return await session(rest, environment, ignoreWarning)
    if (verb === 'trust') return trust(rest, environment)
    if (verb === 'approvals') return await approvals(rest, environment)
    if (verb === 'approve') return await approve(rest, environment, options.confirm === undefined ? terminalConfirm({ input: process.stdin, output: process.stdout }) : options.confirm, ignoreWarning)
  } catch (error) {
    if (error instanceof ClientError || error instanceof OwnerOnlyError) return fail(error.message)
    throw error
  }
  return fail(USAGE)
}

/**
 * Where this device keeps its key: BUCKLE_CLIENT_DIR when set, which must be absolute and on Windows not a whole drive,
 * as typed or where it really is, or ~/.5straps/client. `platform`: the host's unless a test imitates another.
 */
export function clientDirectory(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const named = environment.BUCKLE_CLIENT_DIR
  if (!named) return join(homeDirectory(platform), '.5straps', 'client')
  if (!isAbsolute(named)) throw new ClientError(`BUCKLE_CLIENT_DIR must be an absolute path, not ${named}`)
  const directory = typedPath(named, platform)
  for (const spelling of [directory, realPathOf(directory, platform)]) {
    if (isDriveRoot(spelling, platform)) throw new ClientError(`BUCKLE_CLIENT_DIR is ${spelling}: ${WHOLE_DRIVE}`)
  }
  return directory
}

/** This device's key, refused when other users can read it, as ssh refuses an unprotected key. */
export function loadClientKey(environment: NodeJS.ProcessEnv = process.env, ownerOnly: OwnerOnlyCheck = {}): SigningKey & { publicKey: string } {
  const file = join(clientDirectory(environment), CLIENT_KEY_FILE)
  if (!existsSync(file)) throw new ClientError(`No signing key at ${file}: run buckle client keygen first`)
  requireOwnerOnly(file, 'file', ownerOnly)
  return signingKeyFromPem(readFileSync(file, 'utf8'))
}

class ClientError extends Error {}

function keygen(argv: string[], environment: NodeJS.ProcessEnv): CliResult {
  const { values } = parseArgs({ args: argv, options: { force: { type: 'boolean' } }, allowPositionals: false })
  const directory = clientDirectory(environment)
  const file = join(directory, CLIENT_KEY_FILE)
  if (existsSync(file) && !values.force) throw new ClientError(`${file} already holds this device's key; pass --force to replace it, then enroll the new one and revoke the old`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  setMode(directory, 0o700)
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
  return `Public key:  ${key.publicKey}\nFingerprint: ${key.keyId}\nOn the node: buckle keys enroll ${key.publicKey} --purpose setup|approval --workspace <name>|node --label <this device>\n`
}

async function request(argv: string[], environment: NodeJS.ProcessEnv, ignoreWarning: boolean): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { body: { type: 'string' }, purpose: { type: 'string' }, node: { type: 'string' }, session: { type: 'string' } }, allowPositionals: true })
  const [method, target] = positionals
  if (!method || !target || positionals.length !== 2) throw new ClientError(USAGE)
  const url = new URL(target)
  const response = await send({ environment, method, url, body: values.body ?? '', purpose: purposeOf(values.purpose, url.pathname), ignoreWarning, ...(values.node ? { node: values.node } : {}), ...(values.session ? { session: values.session } : {}) })
  return report(response, await response.text())
}

/**
 * Sends one request, signed with this device's key for the node pinned for the URL (its serverId and
 * its key's fingerprint), the workspace, method, path and exact body. An unpinned URL, or a --node
 * that is not the pinned one, signs nothing. `ignoreWarning` asks, in the signed query, for a change the node's log
 * cannot record to be made anyway (APPROVAL-16).
 */
async function send(input: { environment: NodeJS.ProcessEnv; method: string; url: URL; body: string; purpose: SignedRequestPurpose; node?: string; session?: string; ignoreWarning?: boolean }): Promise<Response> {
  const method = input.method.toUpperCase()
  if (input.ignoreWarning) input.url.searchParams.set(IGNORE_WARNING_QUERY, 'true')
  // A path that names no workspace is the node level, which a node-scoped key signs for (D85, Q15).
  const workspace = decodeURIComponent(/^\/workspaces\/([^/]+)\//.exec(input.url.pathname)?.[1] ?? 'node')
  if (workspace.length > SIGNED_WORKSPACE_MAX) throw new ClientError(`The workspace name is longer than the ${SIGNED_WORKSPACE_MAX} characters a signed request names; name the workspace by its id, as buckle workspace list prints it. Nothing was signed.`)
  const pin = pinFor(input.environment, input.url)
  if (input.node !== undefined && input.node !== pin.serverId) throw new ClientError(`--node names ${input.node}, but ${input.url.origin} is pinned as ${pin.serverId}; nothing was signed`)
  let authorization: string
  try {
    authorization = signRequest({
      key: loadClientKey(input.environment), purpose: input.purpose, node: pin.serverId, nodeKey: keyIdOf(pin.publicKey), workspace,
      method, path: `${input.url.pathname}${input.url.search}`, body: input.body, ...(input.session ? { session: input.session } : {}),
    })
  } catch (error) {
    // A request the protocol will not carry (a path over its limit, say) is refused plainly, not with the schema's dump.
    if (error instanceof z.ZodError) throw new ClientError(`Nothing was signed: ${error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    throw error
  }
  return fetch(input.url, { method, headers: { authorization, ...(input.body ? { 'content-type': 'application/json' } : {}) }, ...(input.body ? { body: input.body } : {}), signal: AbortSignal.timeout(30_000) })
}

function report(response: Response, text: string): CliResult {
  const stopped = recordStopped(response, text)
  if (stopped) return stopped
  process.stderr.write(`HTTP ${response.status}\n`)
  if (text) process.stdout.write(`${text}\n`)
  return { exitCode: response.ok ? 0 : 1 }
}

/** A node URL and the workspace, by name or id, as the route for one of its setup paths; without one, the node level, which serves no workspace. */
function setupUrl(node: string, workspace: string | undefined, path: string): URL {
  const prefix = workspace ? `/workspaces/${encodeURIComponent(workspace)}` : ''
  return new URL(`${prefix}/setup/${path}`, new URL(node).origin)
}

async function session(argv: string[], environment: NodeJS.ProcessEnv, ignoreWarning: boolean): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' } }, allowPositionals: true })
  const [action, node, id] = positionals
  if (action === 'open' && node && positionals.length === 2) {
    const response = await send({ environment, method: 'POST', url: setupUrl(node, values.workspace, 'sessions'), body: '', purpose: 'buckle-setup', ignoreWarning })
    const text = await response.text()
    const stopped = recordStopped(response, text)
    if (stopped) return stopped
    if (response.ok) process.stdout.write(`${(JSON.parse(text) as { session: { id: string } }).session.id}\n`)
    else process.stderr.write(`HTTP ${response.status} ${text}\n`)
    return { exitCode: response.ok ? 0 : 1 }
  }
  if (action === 'close' && node && id && positionals.length === 3) {
    const response = await send({ environment, method: 'DELETE', url: setupUrl(node, values.workspace, `sessions/${encodeURIComponent(id)}`), body: '', purpose: 'buckle-setup', session: id, ignoreWarning })
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
  // Asks for the workspace's name beside its id; a node from before the name existed ignores the field and sends none.
  const url = setupUrl(input.node, input.workspace, 'approvals/challenges?fields=workspaceName')
  const pin = pinFor(input.environment, url)
  const response = await send({ environment: input.environment, method: 'GET', url, body: '', purpose: 'buckle-approval' })
  if (!response.ok) throw new ClientError(`The node answered HTTP ${response.status}${response.status === 401 || response.status === 404 ? `; check that --workspace names the workspace this device's key is enrolled for` : ''}`)
  const body = await response.json() as { challenges?: Array<{ token: string; signed?: unknown; error?: unknown }>; calls?: Record<string, unknown> }
  const nodeKey = publicKeyFrom(pin.publicKey)
  const listed = Array.isArray(body.challenges) ? body.challenges : []
  const sharedCalls = new Map<string, { call: ShownApprovalCall; digest: string } | null>()
  const challenges = listed.flatMap((item) => {
    if (typeof item.signed !== 'string') return []
    const read = readChallenge({ signed: item.signed, nodeKey })
    if (!read || read.challenge.node !== pin.serverId || read.challenge.token !== item.token) return []
    const shared = read.challenge.callRef === undefined ? null : verifiedSharedCall({ reference: read.challenge.callRef, calls: body.calls, known: sharedCalls })
    const consistent = read.challenge.callRef === undefined
      ? recomputes(read.challenge)
      : shared !== null && shared.call.tool === read.challenge.tool && shared.digest === read.challenge.callDigest
    const challenge = consistent && shared !== null ? { ...read.challenge, arguments: shared.call.arguments, cwd: shared.call.cwd, description: shared.call.description, effects: shared.call.effects } : read.challenge
    return [{ token: item.token, digest: read.digest, challenge, consistent }]
  })
  // An entry beside a verified challenge for the same token says nothing the challenge does not.
  const verified = new Set(challenges.map(item => item.token))
  const unsigned = listed.flatMap(item => typeof item.signed !== 'string' && typeof item.token === 'string' && typeof item.error === 'string' && !verified.has(item.token) ? [{ token: item.token, error: item.error }] : [])
  return { pin, origin: url.origin, challenges, unsigned }
}

function verifiedSharedCall(input: { reference: string; calls: Record<string, unknown> | undefined; known: Map<string, { call: ShownApprovalCall; digest: string } | null> }): { call: ShownApprovalCall; digest: string } | null {
  if (input.known.has(input.reference)) return input.known.get(input.reference) ?? null
  const parsed = ShownApprovalCallSchema.safeParse(input.calls?.[input.reference])
  const verified = parsed.success && shownCallDigestOf(parsed.data) === input.reference
    ? { call: parsed.data, digest: callDigestOf(parsed.data) }
    : null
  input.known.set(input.reference, verified)
  return verified
}

/**
 * The two fixed reasons the node lists in place of a challenge (layers/admin/server/routes/setup/approvals/
 * challenges.get.ts), each with this client's own wording. The listing is unsigned and a relay carries it, so
 * nothing it says is printed: a reason not among these reads "unrecognised entry" (review L5).
 */
const UNSIGNED_REASONS: ReadonlyMap<string, string> = new Map([
  // Also listed for an ask whose kept call is missing or damaged (slice 7 review R7-RR-4); the node's text is unchanged.
  ['recorded before this build: decide at the node or re-send', 'recorded before the node\'s current build, or its kept call is missing or damaged, so the node holds no whole call for it and no device decides it; deny it at the node, or have the agent re-send the call'],
  ['The node could not sign this ask\'s challenge, so no device can decide it; answer it at the node (buckle approve) or withdraw the call', 'the node could not sign its challenge, so no device decides it; decide it at the node, where buckle approve shows the action first, or withdraw the call'],
])

/** A token as the node issues them; any other token in an unsigned entry is not printed. */
const NODE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An ask listed without a challenge, in this client's words alone: its token when it has a node's shape, and the node's reason as this client knows it. */
function describeUnsigned(item: UnsignedAsk): string {
  const reason = UNSIGNED_REASONS.get(item.error)
  if (!reason || !NODE_TOKEN.test(item.token)) return 'unrecognised entry: not signed by the node, and not shown'
  return `${item.token}  not signed by the node: ${reason}`
}

/**
 * The workspace as the node signed it: its name beside its id, as the person typed the name and the decision binds the
 * id; the id alone from a node built before challenges carried the name (D85, Q15; fix brief 4, finding 13).
 */
function shownWorkspace(challenge: ApprovalChallenge): string {
  return challenge.workspaceName === undefined ? workspaceLabel(challenge.workspace) : `${printable(challenge.workspaceName)} (${printable(challenge.workspace)})`
}

/** The call digest recomputed from the arguments shown; a challenge without them shows no action to decide on. */
function recomputes(challenge: ApprovalChallenge): boolean {
  return challenge.arguments !== null && challenge.callDigest === callDigestOf({ tool: challenge.tool, arguments: challenge.arguments })
}

/**
 * The whole action from the verified challenge and nothing a relay described (owner decisions D9 and D17):
 * the node and workspace, the node's summary, rule, subject, reason, directory, every judged effect and the
 * complete arguments, with a size line first when they are large. Every field is agent-influenced, so each
 * passes through printable(), and the arguments are printed as JSON with every unprintable character
 * escaped: nothing in a challenge can move the cursor, reorder a line or hide text before a person signs
 * (review item 2 of the proof-of-possession fixes). Nothing is cut or paged.
 */
function describeChallenge(item: VerifiedChallenge, shownWith?: string): string {
  const { challenge } = item
  return [
    `${printable(challenge.token)}  ${printable(challenge.tool)} asks ${printable(challenge.rule)}`,
    ...(shownWith === undefined ? describeAction({ ...challenge, node: challenge.node, workspace: shownWorkspace(challenge), effects: challenge.effects ?? null }) : [
      `  node:     ${printable(challenge.node)}`,
      `  workspace: ${shownWorkspace(challenge)}`,
      `  rule:     ${printable(challenge.rule)}`,
      `  subject:  ${printable(challenge.subject)}`,
      `  reason:   ${printable(challenge.reason)}`,
      `  ${sameCallNote(shownWith)}`,
    ]),
    `  scopes:   ${challenge.offeredScopes.join(', ')}; expires ${printable(challenge.expiresAt)}`,
    `  call:     ${challenge.callDigest ?? 'not recorded'}; session ${printable(challenge.sessionId)}`,
    ...(challenge.truncated ? [`  WARNING: a node built before full display cut this call's arguments or summary; approve refuses it: decide it at the node, or update the node and re-send the call`] : []),
    ...(item.consistent ? [] : [challenge.callRef === undefined ? '  WARNING: the arguments shown do not match the call digest; approve refuses this ask' : '  WARNING: the shared whole action does not match its node-signed reference or call digest; approve refuses this ask']),
  ].join('\n')
}

async function approvals(argv: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' } }, allowPositionals: true })
  const [node] = positionals
  if (!node || positionals.length !== 1) throw new ClientError(USAGE)
  const { challenges, unsigned } = await verifiedChallenges({ environment, node, workspace: namedWorkspace(values.workspace) })
  const carried = new Map<string, string>()
  const shown = [...challenges.map(item => {
    const reference = item.consistent ? item.challenge.callRef : undefined
    const first = reference === undefined ? undefined : carried.get(reference)
    if (reference !== undefined && first === undefined) carried.set(reference, item.token)
    return describeChallenge(item, first)
  }), ...unsigned.map(describeUnsigned)]
  process.stdout.write(shown.length === 0 ? 'Nothing is waiting for approval.\n' : `${shown.join('\n')}\n`)
  return { exitCode: 0 }
}

async function approve(argv: string[], environment: NodeJS.ProcessEnv, confirm: Confirm | null, ignoreWarning: boolean): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: argv, options: { workspace: { type: 'string' }, deny: { type: 'boolean' }, scope: { type: 'string' } }, allowPositionals: true })
  const [node, token] = positionals
  if (!node || !token || positionals.length !== 2) throw new ClientError(USAGE)
  const scope = values.scope ?? 'once'
  if (scope !== 'once' && scope !== 'session' && scope !== 'always') throw new ClientError('--scope takes once, session or always')
  const { pin, origin, challenges, unsigned } = await verifiedChallenges({ environment, node, workspace: namedWorkspace(values.workspace) })
  const found = challenges.find(item => item.token === token)
  const refused = unsigned.find(item => item.token === token)
  if (!found && refused) throw new ClientError(`${describeUnsigned(refused)}; nothing was signed`)
  if (!found) throw new ClientError(`No waiting ask ${printable(token)} that ${printable(pin.serverId)}'s pinned key signed`)
  process.stdout.write(`Node:  ${printable(pin.serverId)}  ${keyIdOf(pin.publicKey)}  at ${printable(origin)}\n${describeChallenge(found)}\n`)
  if (!found.consistent && found.challenge.callRef !== undefined) throw new ClientError(`The shared whole action for ${printable(token)} does not match its node-signed reference or call digest; nothing was signed`)
  if (!found.consistent) throw new ClientError(`The arguments ${printable(pin.serverId)} shows for ${printable(token)} do not recompute to its call digest; nothing was signed`)
  // D17: the whole action is shown or nothing is signed; there is no override for a cut one.
  if (found.challenge.truncated === true) throw new ClientError(`${printable(pin.serverId)} showed ${printable(token)} only in part (a node built before full display), so nothing was signed; decide it at the node, or update the node and re-send the call`)
  if (!values.deny) {
    if (!confirm) throw new ClientError(`Approving needs a person at a terminal after the whole action is shown; run buckle client approve ${printable(node)} ${printable(token)} at a terminal, or use --deny without one`)
    if (!await confirm('Approve exactly this action? Type yes to confirm: ')) {
      process.stdout.write('Not approved; the ask is still waiting.\n')
      return { exitCode: 1 }
    }
  }
  const body = JSON.stringify({ token, approved: !values.deny, scope, challenge: found.digest })
  const response = await send({ environment, method: 'POST', url: setupUrl(node, values.workspace, 'approvals'), body, purpose: 'buckle-approval', node: pin.serverId, ignoreWarning })
  const text = await response.text()
  const reported = report(response, text)
  const warning = unsavedWarning({ text, scope })
  if (warning === undefined) return reported
  process.stderr.write(`${warning}\n`)
  return { exitCode: SAVE_FAILED_EXIT }
}

const RecordStoppedSchema = z.object({ code: z.literal(OWNER_RECORD_UNAVAILABLE), recordError: z.string().max(200).optional() })

/** The node's refusal of a change its own record stopped, said as this command's flag makes it anyway; null for any other answer. */
function recordStopped(response: Response, text: string): CliResult | null {
  if (response.status !== 503) return null
  const parsed = RecordStoppedSchema.safeParse(jsonOf(text))
  if (!parsed.success) return null
  process.stderr.write(`HTTP ${response.status}\n`)
  return stoppedForNodeRecord(parsed.data.recordError === undefined ? undefined : printable(parsed.data.recordError))
}

/** What the node answers of a decision whose grant it could not save: an approval left owed, or a lasting denial refused. */
const UnsavedAnswerSchema = z.union([
  z.object({ resolved: z.literal(true), grantOwed: z.literal(true), saveError: z.string().max(200).optional() }),
  z.object({ error: z.string().max(2_000), code: z.literal('grant_unsaved'), saveError: z.string().max(200).optional() }),
])

/**
 * The warning for a decision the node recorded, or refused, without saving its grant (the owner's ruling: a warning; a
 * device's retry and skip wait for the remote round). Undefined for any other answer.
 */
function unsavedWarning(input: { text: string; scope: 'once' | 'session' | 'always' }): string | undefined {
  const parsed = UnsavedAnswerSchema.safeParse(jsonOf(input.text))
  if (!parsed.success) return undefined
  const answer = parsed.data
  if (input.scope === 'once') return undefined
  const reason = answer.saveError === undefined ? undefined : printable(answer.saveError)
  if ('code' in answer) return `${unsavedDenial({ scope: input.scope, reason })}.`
  return `${unsavedApproval({ scope: input.scope, reason })}.\n${saveEndingLine({ ending: 'left', kind: 'approval' })}`
}

// A body that is not JSON is no answer about a save.
function jsonOf(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return null }
}

/** The node level serves no workspace's approvals, so a device names the workspace, which its key is enrolled for (D85, Q15). */
function namedWorkspace(workspace: string | undefined): string {
  if (workspace === undefined) throw new ClientError('Name the workspace with --workspace <name>: the node level serves no workspace\'s approvals, and a device key signs for one workspace. Nothing was signed.')
  return workspace
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
