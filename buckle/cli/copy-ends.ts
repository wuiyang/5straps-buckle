import { readFileSync } from 'node:fs'
import { requireOwnerOnly, type OwnerOnlyCheck } from '../common/adapters/file-modes.js'
import { buckleVariables, nodeLocation } from '../common/runtime/environment.js'
import { runningNode, type RunningNode } from '../common/services/node-service/serve-record.js'

/**
 * One end of a `buckle cp`: a file on the machine the command runs on, or a file in a workspace of the node, named by the
 * workspace's name or id and a path in any spelling fs_write takes there.
 */
export type CopyEnd = { kind: 'local'; path: string } | { kind: 'workspace'; workspace: string; path: string }

/** A command line `buckle cp` cannot read: exit 2, with the usage. */
export class CopyUsageError extends Error {
  override readonly name = 'CopyUsageError'
}

/** A copy refused before or by the node: exit 1, with the reason. */
export class CopyRefusal extends Error {
  override readonly name = 'CopyRefusal'
}

const LOCAL_PREFIX = 'local:'
/** The workspace path an end names by `<workspace>:` alone: the workspace's folder, as scp's `host:` names the home folder. */
const WORKSPACE_FOLDER = '.'

/**
 * Reads one end as scp reads a host: `local:<path>` and a bare path are files here; `<workspace>:<path>` is a file in
 * that workspace, the workspace being everything before the first colon. A slash or a backslash before that colon makes
 * the end a path here, as no workspace's name holds either; on Windows so does a single letter before it followed by a
 * slash or a backslash, which is a drive (`C:\x`), so a workspace named with one letter is written there by its id.
 */
export function parseEnd(text: string, platform: NodeJS.Platform = process.platform): CopyEnd {
  if (text === '') throw new CopyUsageError('An end of the copy is empty: name a file here, or <workspace>:<path>')
  if (text.startsWith(LOCAL_PREFIX)) {
    const path = text.slice(LOCAL_PREFIX.length)
    if (path === '') throw new CopyUsageError('local: names no file: write local:<path>')
    return { kind: 'local', path }
  }
  const colon = text.indexOf(':')
  if (colon === -1) return { kind: 'local', path: text }
  const before = text.slice(0, colon)
  const after = text.slice(colon + 1)
  if (/[/\\]/.test(before)) return { kind: 'local', path: text }
  if (platform === 'win32' && /^[A-Za-z]$/.test(before) && /^[/\\]/.test(after)) return { kind: 'local', path: text }
  if (before === '') throw new CopyUsageError('An end begins with a colon, so it names no workspace: write <workspace>:<path>, or local:<path> for a file here')
  return { kind: 'workspace', workspace: before, path: after === '' ? WORKSPACE_FOLDER : after }
}

/** The flags that would carry the token itself, which `buckle cp` refuses whatever follows them. */
const TOKEN_FLAGS = ['--token', '--auth-token', '--bearer']

/**
 * Refuses a command line that carries a token, before anything reads it: a value there is in the shell's history and in
 * every process listing. Says only that one was given, never what.
 */
export function refuseTokenArgument(argv: readonly string[]): void {
  const terminator = argv.indexOf('--')
  const flags = terminator === -1 ? argv : argv.slice(0, terminator)
  if (flags.some(argument => TOKEN_FLAGS.some(flag => argument === flag || argument.startsWith(`${flag}=`)))) {
    throw new CopyUsageError('buckle cp takes no token on its command line, where the shell\'s history and other users\' process listings would show it: set BUCKLE_AUTH_TOKEN, or pass --token-file <file> naming an owner-only file with a BUCKLE_AUTH_TOKEN=<token> line')
  }
}

/** The workspace agent token a copy presents, and where it came from, as a message may name it: the file's path, never its value. */
export interface CopyToken { token: string; source: string }

/**
 * The agent token, from `--token-file` where it is given, else BUCKLE_AUTH_TOKEN: an owner-only file in the buckle.env
 * shape, whose BUCKLE_AUTH_TOKEN line is read and no other value. A file other users can read is refused as a key file is.
 */
export function copyToken(input: { environment: NodeJS.ProcessEnv; tokenFile?: string; ownerOnly?: OwnerOnlyCheck }): CopyToken {
  if (input.tokenFile !== undefined) return tokenFromFile(input.tokenFile, input.ownerOnly)
  const token = input.environment.BUCKLE_AUTH_TOKEN?.trim()
  if (!token) throw new CopyRefusal('No agent token: set BUCKLE_AUTH_TOKEN to the workspace\'s agent token, or pass --token-file <file> naming an owner-only file with a BUCKLE_AUTH_TOKEN=<token> line')
  return { token, source: 'BUCKLE_AUTH_TOKEN' }
}

function tokenFromFile(file: string, ownerOnly: OwnerOnlyCheck | undefined): CopyToken {
  requireOwnerOnly(file, 'file', ownerOnly)
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (error) {
    throw new CopyRefusal(`${file} could not be read (${codeOf(error)}), so no token was taken from it`)
  }
  const token = Object.fromEntries(buckleVariables(text)).BUCKLE_AUTH_TOKEN?.trim()
  if (!token) throw new CopyRefusal(`${file} holds no BUCKLE_AUTH_TOKEN=<token> line`)
  return { token, source: file }
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unreadable'
}

/**
 * The node a copy goes to: `--node`, else BUCKLE_NODE_URL, else the node `buckle serve` runs on this machine, at the
 * address its serve record names. An http or https URL, its origin alone.
 */
export async function copyNode(input: { flag?: string; environment: NodeJS.ProcessEnv; running?: (stateDirectory: string) => Promise<RunningNode | null> }): Promise<URL> {
  const named = input.flag ?? (input.environment.BUCKLE_NODE_URL?.trim() || undefined)
  if (named !== undefined) return nodeOrigin(named)
  const running = await (input.running ?? runningNode)(nodeLocation(input.environment).stateDirectory).catch(() => null)
  const record = running?.record
  if (record) return new URL(`http://${connectableHost(record.host)}:${record.port}`)
  throw new CopyRefusal('No node to copy with: no buckle serve runs on this machine, so pass --node <url>, or set BUCKLE_NODE_URL, to the node that serves the workspace')
}

function nodeOrigin(named: string): URL {
  let url: URL
  try { url = new URL(named) } catch { throw new CopyUsageError('--node and BUCKLE_NODE_URL take a URL such as http://127.0.0.1:4320, and the one given does not read as a URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CopyUsageError(`The node's URL must be http or https, not ${url.protocol.replace(/:$/, '')}`)
  if (url.username || url.password) throw new CopyUsageError('The node\'s URL carries no user or password: the agent token is the credential, from BUCKLE_AUTH_TOKEN or --token-file')
  return new URL(url.origin)
}

/** Where a client reaches a node listening on `host`: a wildcard address is this machine's loopback; an IPv6 literal goes in brackets. */
function connectableHost(host: string): string {
  if (host === '0.0.0.0' || host === '') return '127.0.0.1'
  if (host === '::') return '[::1]'
  return host.includes(':') ? `[${host}]` : host
}
