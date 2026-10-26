import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, read, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { constants as osConstants } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import type { ApprovalRequest, InvokeResponse } from '@5straps/protocol'
import { OwnerOnlyError, type OwnerOnlyCheck } from '../common/adapters/file-modes.js'
import { isHeldOpen, replaceFile, type RenameIo } from '../common/adapters/replace-file.js'
import { describeApprovalRequest, printable } from '../common/domain/approval-instruction.js'
import type { RunningNode } from '../common/services/node-service/serve-record.js'
import { TARGET_IS_DIRECTORY } from '../common/services/packs/fs/transfer.js'
import { copyNode, copyToken, CopyRefusal, CopyUsageError, parseEnd, refuseTokenArgument, type CopyEnd } from './copy-ends.js'

export interface CliResult { exitCode: number }

export const COPY_USAGE = `Usage: buckle cp <from> <to> [--node <url>] [--token-file <file>]

Copies one file between this machine and a workspace on a Buckle node. The bytes go over the node's HTTP face, never
through an agent, and the node judges each copy as it judges fs_write and fs_read: a copy that needs a person waits
here until it is approved at the node, or denied.

  <path> or local:<path>     a file on this machine
  <workspace>:<path>         a file in that workspace, by its name or id; <path> as fs_write takes it there,
                             relative to the workspace's folder or under its mount such as /workspace;
                             <workspace>: alone is the workspace's folder

  A slash before the first colon keeps an end on this machine (./notes:2026.txt). On Windows, C:\\ or C:/ is a
  drive here, so a workspace named with one letter is written by its id. A workspace whose name holds a colon is
  written by its id too. A <to> that is a folder takes the file's own name; a <to> whose folder does not exist is
  refused, as no folder is made. Two files on this machine: use cp. Two workspaces: not yet, as a token opens one
  workspace; copy the file out to this machine, then into the other. Workspaces on two nodes: not yet.

  --node <url>        The node, such as http://127.0.0.1:4320; else BUCKLE_NODE_URL; else the node buckle serve runs here
  --token-file <file> An owner-only file with a BUCKLE_AUTH_TOKEN=<token> line, the workspace's agent token; else
                      BUCKLE_AUTH_TOKEN. The token is never taken from the command line.

Exits 0 once copied, 1 when the node or the copy refuses, 2 on a command line it cannot read.
`

/** How long a connection to the node may take, as buckle client waits (cli/client.ts). */
const CONNECT_TIMEOUT_MS = 30_000
/** How often a copy waiting for a person is sent again; the node holds each one for its own wait first. */
const POLL_MS = 2_000
/** The session a copy's asks and grants are kept in, apart from an agent's own, which names none or its own. */
const COPY_SESSION = 'buckle-cp'
/** The mode a downloaded file is made with where none is replaced: owner only, as the workspace's file may be a secret. */
const NEW_FILE_MODE = 0o600
/** The signals that stop a copy where it stands, which remove a download's new file before the process ends. */
const STOPPING: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
/** What a JSON answer may hold; a node's answer is far smaller. */
const MAX_ANSWER_BYTES = 1_048_576
const CHUNK_BYTES = 1_048_576
const readAt = promisify(read)
/** Said of a node from before the files face, which answers its catch-all 404 there. */
const OLD_NODE = 'This node\'s Buckle offers no file copy; it needs 0.1.8 or later'

interface Output { write(text: string): unknown }

export interface CopyOptions {
  /** The host's unless a test imitates another: on Windows a drive letter keeps an end here. */
  platform?: NodeJS.Platform
  stdout?: Output
  stderr?: Output
  /** How long a copy waiting for a person sleeps between sends; POLL_MS by default. */
  pollMs?: number
  /** The serve record lookup, for a test; this machine's own by default. */
  running?: (stateDirectory: string) => Promise<RunningNode | null>
  ownerOnly?: OwnerOnlyCheck
  /** The rename that puts a download in place, and the pause between its tries; the system's, with Windows' retries, by default. */
  renameIo?: RenameIo
  /** What a signal that stops the copy is heard on, and how the copy then exits; the process by default. */
  signals?: SignalHost
}

/** The part of `process` that stops a copy on a signal. */
export interface SignalHost {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
  exit(code: number): unknown
}

/**
 * `buckle cp <from> <to>`: one file between this machine and a workspace of a node, through PUT and GET /v1/files under
 * a workspace agent token, which opens its own workspace alone, so two workspaces are refused. Exit 0 on a copy, 1 on a refusal or a denial, 2 on
 * a command line it cannot read. Runs before the node's own settings load: this machine needs no node.
 */
export async function copyCommand(argv: string[], environment: NodeJS.ProcessEnv = process.env, options: CopyOptions = {}): Promise<CliResult> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  try {
    if (['--help', '-h', 'help'].includes(argv[0] ?? '')) {
      stdout.write(COPY_USAGE)
      return { exitCode: 0 }
    }
    refuseTokenArgument(argv)
    const { values, positionals } = readArguments(argv)
    if (positionals.length !== 2) throw new CopyUsageError('Name two ends: buckle cp <from> <to>')
    const platform = options.platform ?? process.platform
    const from = parseEnd(positionals[0]!, platform)
    const to = parseEnd(positionals[1]!, platform)
    const route = routeOf(from, to)
    const node = await copyNode({ ...(values.node === undefined ? {} : { flag: values.node }), environment, ...(options.running ? { running: options.running } : {}) })
    const token = copyToken({ environment, ...(values['token-file'] === undefined ? {} : { tokenFile: values['token-file'] }), ...(options.ownerOnly ? { ownerOnly: options.ownerOnly } : {}) })
    const client: NodeClient = { node, token: token.token, tokenSource: token.source, stderr, pollMs: options.pollMs ?? POLL_MS, platform, ...(options.renameIo ? { renameIo: options.renameIo } : {}) }
    const stopGuard = guardSignals(options.signals ?? process, platform)
    let copied: Copied
    try {
      copied = route.direction === 'in' ? await upload(client, { path: route.from.path, name: basename(route.from.path) }, route.to) : await download(client, route.from, route.to)
    } finally { stopGuard() }
    stdout.write(`Copied ${copied.size} bytes to ${shownEnd(copied.end)} (sha256 ${copied.sha256})\n`)
    return { exitCode: 0 }
  } catch (error) {
    if (error instanceof CopyUsageError || isParseArgsError(error)) {
      stderr.write(`${(error as Error).message}\n\n${COPY_USAGE}`)
      return { exitCode: 2 }
    }
    if (error instanceof CopyRefusal || error instanceof OwnerOnlyError) {
      stderr.write(`${error.message}\n`)
      return { exitCode: 1 }
    }
    throw error
  }
}

function readArguments(argv: string[]) {
  return parseArgs({ args: argv, options: { node: { type: 'string' }, 'token-file': { type: 'string' } }, allowPositionals: true, strict: true })
}

function isParseArgsError(error: unknown): boolean {
  return error instanceof TypeError && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')
}

interface NodeClient { node: URL; token: string; tokenSource: string; stderr: Output; pollMs: number; platform: NodeJS.Platform; renameIo?: RenameIo }
type WorkspaceEnd = Extract<CopyEnd, { kind: 'workspace' }>
type LocalEnd = Extract<CopyEnd, { kind: 'local' }>
interface Copied { size: number; sha256: string; end: CopyEnd }

type Route = { direction: 'in'; from: LocalEnd; to: WorkspaceEnd } | { direction: 'out'; from: WorkspaceEnd; to: LocalEnd }

/** Which way the file goes; two files here, or two workspaces, are refused before the node or the token is looked at. */
function routeOf(from: CopyEnd, to: CopyEnd): Route {
  if (from.kind === 'local' && to.kind === 'workspace') return { direction: 'in', from, to }
  if (from.kind === 'workspace' && to.kind === 'local') return { direction: 'out', from, to }
  throw new CopyUsageError(from.kind === 'local' ? 'Both ends are files on this machine: use cp' : 'Both ends are workspaces: a token opens one workspace, so copy the file out to this machine first, then into the other')
}

/** One local file into a workspace: hashed once, then sent from the same descriptor at each send. */
async function upload(client: NodeClient, source: { path: string; name: string }, to: WorkspaceEnd): Promise<Copied> {
  const file = openLocal(source.path)
  try {
    let path = to.path
    let requestId = randomUUID()
    for (let named = false; ; named = true) {
      const answer = await untilDecided(client, to.workspace, () => putOnce(client, { workspace: to.workspace, path, requestId, file }))
      // A <to> that is a folder takes the file's own name, as cp does, under a call of its own.
      if (answer.outcome === 'error' && answer.error.code === TARGET_IS_DIRECTORY && !named) {
        path = beneath(path, source.name)
        requestId = randomUUID()
        continue
      }
      if (answer.outcome !== 'ok') throw refusalOf(answer)
      return { size: file.size, sha256: file.sha256, end: { ...to, path } }
    }
  } finally {
    closeSync(file.descriptor)
  }
}

/** One workspace file to this machine: into a new file beside the target, renamed onto it once whole and matching. */
async function download(client: NodeClient, from: WorkspaceEnd, to: LocalEnd): Promise<Copied> {
  const target = localTarget(to.path, workspaceName(from.path), client.platform)
  const requestId = randomUUID()
  const answer = await untilDecided(client, from.workspace, () => getOnce(client, { workspace: from.workspace, path: from.path, requestId, target }))
  if (answer.outcome !== 'ok') throw refusalOf(answer)
  const output = answer.output as { size: number; sha256: string }
  return { size: output.size, sha256: output.sha256, end: { kind: 'local', path: target } }
}

/** What one send came to: the node's answer, or the asks a person has yet to answer. */
type Attempt = { kind: 'answered'; answer: InvokeResponse } | { kind: 'asked'; approvals: ApprovalRequest[] }

/**
 * Sends the copy until a person has decided its asks: each approval_required prints the node's instruction once per ask,
 * as an agent is told it, and waits, then sends the same request again under the same requestId, which joins those asks.
 * An ask that expires unanswered ends the wait.
 */
async function untilDecided(client: NodeClient, workspace: string, send: () => Promise<Attempt>): Promise<InvokeResponse> {
  const shown = new Set<string>()
  for (;;) {
    const attempt = await send()
    if (attempt.kind === 'answered') return attempt.answer
    const fresh = attempt.approvals.filter(approval => !shown.has(approval.token))
    if (fresh.length > 0) {
      client.stderr.write(`${instruction({ approvals: fresh, workspace, node: client.node })}\nWaiting for the approval...\n`)
      for (const approval of fresh) shown.add(approval.token)
    }
    const expires = Math.min(...attempt.approvals.map(approval => Date.parse(approval.expiresAt)))
    if (Date.now() >= expires) throw new CopyRefusal('The approval expired before anyone answered it, so nothing was copied')
    await delay(client.pollMs)
  }
}

/** The node's instruction for each ask, in the words an agent relays (approval-instruction.ts): run at the node. */
function instruction(input: { approvals: ApprovalRequest[]; workspace: string; node: URL }): string {
  const lines = input.approvals.map((request) => {
    const [first, ...rest] = describeApprovalRequest({ request, workspaceId: input.workspace, workspaceName: input.workspace, nodeName: input.node.origin })
    return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
  })
  return ['This copy needs a person to approve it at the node, with these commands there:', ...lines].join('\n')
}

interface LocalFile { descriptor: number; size: number; sha256: string }

/** A regular file here, opened once and hashed through that descriptor, which every send then reads from its start. */
function openLocal(path: string): LocalFile {
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY) } catch (error) {
    throw new CopyRefusal(`${path} could not be opened (${codeOf(error)}), so nothing was copied`)
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) throw new CopyRefusal(`${path} is not a regular file, so nothing was copied`)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    for (let position = 0; position < info.size;) {
      const read = readSync(descriptor, buffer, 0, Math.min(CHUNK_BYTES, info.size - position), position)
      if (read === 0) throw new CopyRefusal(`${path} changed while it was read, so nothing was copied`)
      hash.update(buffer.subarray(0, read))
      position += read
    }
    return { descriptor, size: info.size, sha256: hash.digest('hex') }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

/**
 * The file from its start, read at positions from the one descriptor, which no stream owns: a send cut short when the
 * node answers before it read the body leaves the descriptor open for the next send.
 */
async function* fromStart(file: LocalFile): AsyncGenerator<Buffer> {
  for (let position = 0; position < file.size;) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, file.size - position))
    const { bytesRead } = await readAt(file.descriptor, buffer, 0, buffer.byteLength, position)
    if (bytesRead === 0) throw new CopyRefusal('The file changed while it was sent, so it was not copied')
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

/** One PUT of the file, from its start. */
async function putOnce(client: NodeClient, input: { workspace: string; path: string; requestId: string; file: LocalFile }): Promise<Attempt> {
  const body = () => Readable.from(fromStart(input.file))
  const exchange = await send({
    url: filesUrl(client.node, input.workspace, input.path), method: 'PUT', body,
    headers: { ...credentials(client, input.requestId), 'content-length': String(input.file.size), 'content-type': 'application/octet-stream', 'x-buckle-sha256': input.file.sha256 },
  })
  try {
    return await readAnswer(client, input.workspace, exchange.response)
  } finally { exchange.close() }
}

/** One GET of the file: its bytes into a new file beside the target, or the node's answer where it sends none. */
async function getOnce(client: NodeClient, input: { workspace: string; path: string; requestId: string; target: string }): Promise<Attempt> {
  const exchange = await send({ url: filesUrl(client.node, input.workspace, input.path), method: 'GET', headers: credentials(client, input.requestId) })
  try {
    const { response } = exchange
    const digest = header(response, 'x-buckle-sha256')
    if (response.statusCode !== 200 || digest === undefined) return await readAnswer(client, input.workspace, response)
    const size = Number(header(response, 'content-length'))
    if (!Number.isSafeInteger(size) || !/^[a-f0-9]{64}$/.test(digest)) throw new CopyRefusal('The node sent a file without its size or digest, so nothing was written')
    await receive({ response, size, digest, target: input.target, ...(client.renameIo ? { renameIo: client.renameIo } : {}) })
    return { kind: 'answered', answer: { requestId: input.requestId, outcome: 'ok', output: { size, sha256: digest }, meta: { durationMs: 0, truncated: false } } }
  } finally { exchange.close() }
}

/**
 * The response's bytes into a new file beside `target`, counted and hashed as they land, and renamed onto it only when
 * every byte the node declared arrived with the digest it named; on anything else the new file is removed. The new file
 * has the mode of the file it replaces, exactly, so a private file is never replaced by one others read, and is owner
 * only where there is none to replace, as the node side's replaceBeneath keeps it (re-checks of 2026-10-14). A signal that
 * stops the copy removes it too (guardSignals).
 */
async function receive(input: { response: IncomingMessage; size: number; digest: string; target: string; renameIo?: RenameIo }): Promise<void> {
  const existing = lstatSync(input.target, { throwIfNoEntry: false })
  const mode = existing === undefined ? NEW_FILE_MODE : existing.mode & 0o777
  const partial = join(dirname(input.target), `.buckle-cp-${randomUUID()}.part`)
  const handle = await open(partial, 'wx', mode).catch((error: unknown) => { throw unwritable(input.target, error) })
  partials.add(partial)
  let kept = false
  try {
    // The kernel only narrows the mode a file is created with; the old file's own is set exactly.
    if (existing !== undefined) await handle.chmod(mode)
    await land({ response: input.response, size: input.size, digest: input.digest, handle, target: input.target })
    await handle.close()
    await replaceDownload(partial, input.target, input.renameIo)
    kept = true
  } finally {
    if (!kept) {
      await handle.close().catch(() => undefined)
      rmSync(partial, { force: true })
    }
    partials.delete(partial)
  }
}

/** The bytes that arrive into the new file, counted and hashed; a length or a digest other than the node declared is refused. */
async function land(input: { response: IncomingMessage; size: number; digest: string; handle: FileHandle; target: string }): Promise<void> {
  const hash = createHash('sha256')
  let landed = 0
  try {
    for await (const chunk of input.response as AsyncIterable<Buffer>) {
      landed += chunk.byteLength
      if (landed > input.size) throw new CopyRefusal('The node sent more bytes than it declared, so nothing was written')
      hash.update(chunk)
      await input.handle.write(chunk).catch((error: unknown) => { throw unwritable(input.target, error) })
    }
  } catch (error) {
    if (error instanceof CopyRefusal) throw error
    throw new CopyRefusal(`The node cut the file short (${codeOf(error)}); it does so when a file changes while it is sent, so run buckle cp again. Nothing was written`)
  }
  if (landed !== input.size) throw new CopyRefusal(`Only ${landed} of the ${input.size} bytes the node declared arrived; the node cuts a file short when it changes while it is sent, so run buckle cp again. Nothing was written`)
  if (hash.digest('hex') !== input.digest) throw new CopyRefusal('The bytes that arrived do not hash to the sha256 the node named, so nothing was written')
}

/** The new file onto the target, tried again where Windows holds the target open, as the state files are (replaceFile). */
async function replaceDownload(partial: string, target: string, io: RenameIo | undefined): Promise<void> {
  try {
    await replaceFile(partial, target, io)
  } catch (error) {
    if (isHeldOpen(error)) throw new CopyRefusal(`${target} is held open by another program (${codeOf(error)}), so it was not replaced; close it and run buckle cp again`)
    throw new CopyRefusal(`${target} could not be replaced (${codeOf(error)}), so nothing was written`)
  }
}

function unwritable(target: string, error: unknown): CopyRefusal {
  return new CopyRefusal(`The file could not be written beside ${target} (${codeOf(error)}), so nothing was written`)
}

/** The new files of the downloads under way, which a signal that stops the copy removes. */
const partials = new Set<string>()

/**
 * For as long as a copy runs, a signal that stops it (and Ctrl-Break on Windows) removes the new file of a download under
 * way and ends the process with the signal's usual code, 128 and its number, as the finally blocks do not run on one.
 * Returns the call that takes the listeners off.
 */
function guardSignals(host: SignalHost, platform: NodeJS.Platform): () => void {
  const names: readonly NodeJS.Signals[] = platform === 'win32' ? [...STOPPING, 'SIGBREAK'] : STOPPING
  const listeners = names.map((name) => {
    const listener = () => {
      for (const partial of partials) {
        try { rmSync(partial, { force: true }) } catch { /* Gone, or not ours to remove; the process ends all the same. */ }
      }
      host.exit(128 + (osConstants.signals[name] ?? 0))
    }
    host.on(name, listener)
    return { name, listener }
  })
  return () => { for (const { name, listener } of listeners) host.off(name, listener) }
}

/**
 * The node's JSON answer: an outcome, or the asks still waiting; a node with no files face, a refused token, and a
 * refusal before any call each in words of its own.
 */
async function readAnswer(client: NodeClient, workspace: string, response: IncomingMessage): Promise<Attempt> {
  const text = await readText(response)
  const status = response.statusCode ?? 0
  const parsed = parseJson(text)
  const answer = isInvokeResponse(parsed) ? parsed : null
  if (answer?.outcome === 'approval_required') return { kind: 'asked', approvals: answer.approvals }
  if (answer) return { kind: 'answered', answer }
  if (status === 404 || status === 405) throw new CopyRefusal(`${OLD_NODE} (${client.node.origin} answered HTTP ${status})`)
  if (status === 401) throw new CopyRefusal(`The node refused the token from ${client.tokenSource} (HTTP 401): it is no agent token of workspace ${printable(workspace)} on ${client.node.origin}`)
  const said = parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : (parsed as { message?: unknown } | null)?.message
  throw new CopyRefusal(`The node answered HTTP ${status}${typeof said === 'string' ? `: ${printable(said)}` : ''}`)
}

function refusalOf(answer: InvokeResponse): CopyRefusal {
  if (answer.outcome === 'error') return new CopyRefusal(`${printable(answer.error.code)}: ${printable(answer.error.message)}`)
  return new CopyRefusal('The node answered without the file')
}

function isInvokeResponse(value: unknown): value is InvokeResponse {
  const outcome = (value as { outcome?: unknown } | null)?.outcome
  if (outcome === 'approval_required') return Array.isArray((value as { approvals?: unknown }).approvals)
  if (outcome === 'error') return typeof (value as { error?: { code?: unknown } }).error?.code === 'string'
  return outcome === 'ok'
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return null }
}

async function readText(response: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_ANSWER_BYTES) throw new CopyRefusal('The node\'s answer was larger than any Buckle answer, so it was not read')
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

function credentials(client: NodeClient, requestId: string): Record<string, string> {
  return { authorization: `Bearer ${client.token}`, 'x-buckle-request-id': requestId, 'x-buckle-session': COPY_SESSION }
}

function filesUrl(node: URL, workspace: string, path: string): URL {
  return new URL(`/workspaces/${encodeURIComponent(workspace)}/v1/files?path=${encodeURIComponent(path)}`, node)
}

function header(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name]
  return Array.isArray(value) ? value[0] : value
}

interface Exchange { response: IncomingMessage; close(): void }

/**
 * One request over node:http or node:https on a connection of its own: it must open within CONNECT_TIMEOUT_MS, and
 * nothing after times out here, as the node bounds its own wait. The connection asks to be kept alive, so a node that
 * answers before it has read the body drains the rest rather than closing on it, which resets the connection and can
 * lose the answer; the body is cut here once the answer is read, so the rest is not sent for nothing.
 */
function send(input: { url: URL; method: 'GET' | 'PUT'; headers: Record<string, string>; body?: () => Readable }): Promise<Exchange> {
  const https = input.url.protocol === 'https:'
  const agent = https ? new HttpsAgent({ keepAlive: true, maxSockets: 1 }) : new HttpAgent({ keepAlive: true, maxSockets: 1 })
  const request = (https ? httpsRequest : httpRequest)(input.url, { method: input.method, headers: input.headers, agent })
  const close = () => { request.destroy(); agent.destroy() }
  return new Promise<Exchange>((resolve, reject) => {
    const connecting = setTimeout(() => request.destroy(new CopyRefusal(`The node at ${input.url.origin} did not take the connection within ${CONNECT_TIMEOUT_MS / 1000} seconds`)), CONNECT_TIMEOUT_MS)
    request.once('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connecting)
      else socket.once('connect', () => clearTimeout(connecting))
    })
    request.once('response', (response) => {
      clearTimeout(connecting)
      // Once answered, a body the node no longer reads may fail to send; that is no failure of the copy.
      request.on('error', () => {})
      resolve({ response, close })
    })
    request.once('error', (error) => {
      clearTimeout(connecting)
      agent.destroy()
      reject(error instanceof CopyRefusal ? error : new CopyRefusal(`The node at ${input.url.origin} could not be reached, or closed the connection before it answered (${codeOf(error)})`))
    })
    if (!input.body) {
      request.end()
      return
    }
    const body = input.body()
    body.once('error', error => request.destroy(error))
    body.pipe(request)
    request.once('close', () => body.destroy())
  })
}

/**
 * Where a download lands here, settled before the node is asked for anything: the target, or the file's name inside it
 * where it is a folder; a target that is a link is written through, as cp does, and one that points at nothing, a folder,
 * or a name that ends in a separator without being a folder here is refused, and so is a folder that does not exist.
 */
function localTarget(path: string, name: string, platform: NodeJS.Platform): string {
  const trailing = endsWithSeparator(path, platform)
  const named = trailing ? path.replace(/[/\\]+$/, '') || path : path
  const entry = statSync(named, { throwIfNoEntry: false })
  if (entry?.isDirectory()) return landing(join(named, name))
  if (!trailing) return landing(path)
  if (entry !== undefined) throw new CopyRefusal(`${named} is a file, not a folder, so nothing was written`)
  throw missingFolder(named)
}

function endsWithSeparator(path: string, platform: NodeJS.Platform): boolean {
  return path.endsWith('/') || (platform === 'win32' && path.endsWith('\\'))
}

/** The file a download is written to: the link's file where the target is a link, which must be a regular file in a folder that exists. */
function landing(target: string): string {
  let file = target
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    try { file = realpathSync(target) } catch { throw new CopyRefusal(`${target} is a link to a file that does not exist, so nothing was written; name the file itself`) }
  }
  const entry = statSync(file, { throwIfNoEntry: false })
  if (entry !== undefined && !entry.isFile()) throw new CopyRefusal(`${file} is not a regular file, so nothing was written`)
  const folder = dirname(file)
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw missingFolder(folder)
  return file
}

function missingFolder(folder: string): CopyRefusal {
  return new CopyRefusal(`The folder ${folder} does not exist, and buckle cp makes no folder: create it first, or copy into one that exists`)
}

/** A workspace path's last name, by either separator, as a Windows node's paths may use backslashes. */
function workspaceName(path: string): string {
  const name = path.split(/[/\\]/).filter(Boolean).at(-1)
  if (!name || name === '.' || name === '..') throw new CopyUsageError(`${path} names no file in the workspace`)
  return name
}

/** The source's name inside a workspace folder the copy was sent to, in the spelling the folder was typed in. */
function beneath(folder: string, name: string): string {
  if (folder === '.' || folder === '') return name
  return `${folder.replace(/[/\\]+$/, '')}/${name}`
}

function shownEnd(end: CopyEnd): string {
  return end.kind === 'local' ? end.path : `${end.workspace}:${end.path}`
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : 'unknown'
}
