import { createHash } from 'node:crypto'
import { constants, fstatSync, read, statSync, write } from 'node:fs'
import { promisify } from 'node:util'
import { basename, dirname } from 'pathe'
import { redactCredentials } from '@5straps/runtime'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { openRealDirectory, withFileBeneathAsync, type PinnedDirectory } from '../../../adapters/beneath.js'
import { replaceBeneath, sweepPartials } from '../../../adapters/replace-beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { isInsideAny } from '../../../domain/paths.js'
import { ToolInputError, type FileChannel, type IncomingFile, type OutgoingFile } from '../../../domain/tool.js'
import { isMissingPathError, resolveTarget } from '../../invocation/real-path.js'
import { judgedPath } from '../judged-path.js'
import type * as schemas from './schemas.js'

/** A copy larger than the node takes (BUCKLE_MAX_TRANSFER_BYTES), refused before any byte is kept or sent. */
export const TRANSFER_TOO_LARGE = 'TRANSFER_TOO_LARGE'
/** A `to` that is a folder: `buckle cp` then names the file in it after the source, as cp does. */
export const TARGET_IS_DIRECTORY = 'TARGET_IS_DIRECTORY'
/** A `to` whose folder does not exist: a copy makes no folder. */
export const PARENT_MISSING = 'PARENT_MISSING'
/** A folder to list or search that cannot be opened as one: a file named as the folder, or a folder this node may not open. */
export const SEARCH_ROOT_UNREADABLE = 'SEARCH_ROOT_UNREADABLE'
/** The bytes that arrived are not as many as the request declared. */
export const TRANSFER_LENGTH_MISMATCH = 'TRANSFER_LENGTH_MISMATCH'
/** The bytes that arrived do not hash to the digest the request named. */
export const TRANSFER_DIGEST_MISMATCH = 'TRANSFER_DIGEST_MISMATCH'
/** The file being sent changed between its hash and its last byte, so its response was cut short. */
export const TRANSFER_CHANGED = 'TRANSFER_CHANGED'
/** A `from` that names no file. */
export const FILE_NOT_FOUND = 'FILE_NOT_FOUND'

const CHUNK_BYTES = 1_048_576
/** How much of a path the audit entry keeps, as a description quotes one. */
const AUDITED_PATH_LENGTH = 1_024
const readChunk = promisify(read)
const writeChunk = promisify(write)

export interface TransferContext {
  paths: PathView
  /** Buckle's protected roots: a hard-linked file on their device is not sent (isLinkedOnStateDevice). */
  protectedRoots?: readonly string[]
  /** The largest file one copy moves (BUCKLE_MAX_TRANSFER_BYTES). */
  maxTransferBytes: number
}

/**
 * What fs_receive settles before any rule judges it (ToolDefinition.judge): a copy over the node's limit, a `to` that is
 * a folder, and one whose folder does not exist are refused at once, so no person is asked about a write that would not
 * land. The landing is looked at only inside the roots the agent may name, so a probe learns nothing of the host there;
 * elsewhere the same look is taken once the write is judged (receiveFile).
 */
export function settleReceive(input: z.output<typeof schemas.receiveInput>, context: TransferContext): void {
  if (input.bytes > context.maxTransferBytes) throw tooLarge(input.bytes, context.maxTransferBytes, 'nothing was received')
  const landing = resolveTarget(context.paths.resolve(input.path), { shares: context.paths.shares })
  if (!isInsideAny(context.paths.reachableRoots, landing)) return
  refuseLanding(landing, input.path, context.paths)
}

/**
 * Where an fs_receive would land, refused when it cannot take a file: a folder (`buckle cp` then names the file in it), a
 * name that ends in a separator as a folder does without being one (a copy makes no folder, and replaces no file named as
 * one), or a folder that does not exist. The path was resolved without its trailing separator, so `named` is read for it.
 * A backslash is a separator on Windows alone; elsewhere it is part of a name, as in the path layer (withForwardSlashes).
 * `platform` is the host's unless a test imitates another.
 */
export function refuseLanding(landing: string, named: string, paths: PathView, platform: NodeJS.Platform = process.platform): void {
  const entry = statSync(landing, { throwIfNoEntry: false })
  if (entry?.isDirectory()) throw new ToolInputError(`${named} is a folder: name the file to write in it, as buckle cp does with the source's name`, { code: TARGET_IS_DIRECTORY })
  if (endsInSeparator(named, platform)) {
    if (entry !== undefined) throw new ToolInputError(`${named} is a file, not a folder: name it without the trailing separator to replace it`)
    throw parentMissing(paths.display(landing))
  }
  if (!statSync(dirname(landing), { throwIfNoEntry: false })?.isDirectory()) throw parentMissing(paths.display(dirname(landing)))
}

function endsInSeparator(named: string, platform: NodeJS.Platform): boolean {
  return (platform === 'win32' ? /[/\\]$/ : /\/$/).test(named)
}

/**
 * What fs_send settles before any rule judges it, for the description a person approves (ToolDefinition.facts): the
 * size of the file as it stands then, where one stands there.
 */
export function settleSend(input: z.output<typeof schemas.sendInput>, context: TransferContext): JsonObject {
  const landing = resolveTarget(context.paths.resolve(input.path), { shares: context.paths.shares })
  const entry = statSync(landing, { throwIfNoEntry: false })
  return entry?.isFile() ? { bytes: entry.size } : {}
}

/**
 * The body of one PUT /v1/files, written where the permission check judged the call would write: streamed into a new
 * file beside the target, beneath a folder reached without following a link, counted and hashed as it lands, and renamed
 * onto the target only once every declared byte arrived and their digest is the one named (replaceBeneath). A body that
 * runs long or short, hashes to another digest, or is cut off leaves the target as it was and nothing beside it.
 */
export async function receiveFile(input: z.output<typeof schemas.receiveInput>, context: TransferContext & { authorizeWrite?: (target: string) => boolean; known?: ((target: string) => void) | undefined; signal: AbortSignal; file: FileChannel | undefined; staleAfterMs: number }): Promise<JsonValue> {
  const body = incoming(context.file).body
  if (!body) throw new ToolInputError('The request carried no body to receive')
  const path = context.paths.resolve(input.path)
  const target = judgedPath({ named: input.path, kind: 'write', paths: context.paths, context })
  // Outside the roots the agent may name, the landing is looked at only now, once the write is judged and a person allowed it.
  refuseLanding(target, input.path, context.paths)
  const directory = openParent(target, input.path, context.paths)
  try {
    sweepPartials(directory, context.staleAfterMs)
    await replaceBeneath({ directory, name: basename(target), named: input.path, signal: context.signal, fill: descriptor => land({ body, descriptor, declared: input, signal: context.signal, named: input.path }) })
  } finally { directory.close() }
  context.known?.(target)
  return { path: context.paths.display(path), size: input.bytes, sha256: input.sha256 }
}

/**
 * One GET /v1/files: the file opened beneath its judged parent, never through a link, hashed, then streamed from that
 * same descriptor. Its size and digest go out ahead of the bytes; a file that changes before its last byte is read cuts
 * the response short, as the last chunk is held back until the whole file has hashed to that digest again.
 */
export async function sendFile(input: z.output<typeof schemas.sendInput>, context: TransferContext & { authorizeReadTarget?: (target: string) => boolean; signal: AbortSignal; file: FileChannel | undefined }): Promise<JsonValue> {
  const outgoing = outgoingOf(context.file)
  const path = context.paths.resolve(input.path)
  const target = judgedPath({ named: input.path, kind: 'read', paths: context.paths, context })
  const beneath = { flags: constants.O_RDONLY, shown: input.path, ...(context.protectedRoots ? { protectedRoots: context.protectedRoots, roots: context.paths.reachableRoots } : {}) }
  try {
    return await withFileBeneathAsync(target, beneath, async (descriptor) => {
      const size = fstatSync(descriptor).size
      if (size > context.maxTransferBytes) throw tooLarge(size, context.maxTransferBytes, 'nothing was sent')
      const read = { descriptor, size, signal: context.signal, named: input.path }
      const sha256 = await digestOf(read)
      await outgoing.send({ size, sha256, chunks: chunksOf({ ...read, sha256 }), signal: context.signal })
      return { path: context.paths.display(path), size, sha256 }
    })
  } catch (error) {
    // Told once the read was judged, as a person allowed it: the name lands on nothing to send.
    if (isMissingPathError(error)) throw new ToolInputError(`There is no file at ${input.path}, so nothing was sent`, { code: FILE_NOT_FOUND })
    throw error
  }
}

/** fs_receive's audit facts: where, how many bytes, and their digest, the path with any credential in it hidden. */
export function receivedFacts(input: z.output<typeof schemas.receiveInput>): JsonObject {
  return { path: auditedPath(input.path), bytes: input.bytes, sha256: input.sha256 }
}

/** fs_send's audit facts: the path, and the bytes and digest it sent where it ran. */
export function sentFacts(input: z.output<typeof schemas.sendInput>, output: JsonValue | undefined): JsonObject {
  const sent = output !== null && typeof output === 'object' && !Array.isArray(output) ? output : {}
  return { path: auditedPath(input.path), ...(typeof sent.size === 'number' ? { bytes: sent.size } : {}), ...(typeof sent.sha256 === 'string' ? { sha256: sent.sha256 } : {}) }
}

/** A path as an audit entry keeps it: any credential in it hidden, AUDITED_PATH_LENGTH characters at most. */
export function auditedPath(path: string): string {
  return redactCredentials(path, 'value').slice(0, AUDITED_PATH_LENGTH)
}

function incoming(file: FileChannel | undefined): IncomingFile {
  if (file?.kind !== 'receive') throw new ToolInputError('fs_receive takes its bytes from PUT /v1/files alone')
  return file
}

function outgoingOf(file: FileChannel | undefined): OutgoingFile {
  if (file?.kind !== 'send') throw new ToolInputError('fs_send sends its bytes through GET /v1/files alone')
  return file
}

/** The target's folder, reached without following a link; one that does not exist is refused by name, as a copy makes none. */
function openParent(target: string, named: string, paths: PathView): PinnedDirectory {
  try {
    return openRealDirectory(dirname(target), { refusal: { shown: named } })
  } catch (error) {
    if (isMissingPathError(error)) throw parentMissing(paths.display(dirname(target)))
    throw error
  }
}

/** The body into the new file, counted and hashed as each chunk lands; the caller's cut, the timeout, and the shutdown stop it. */
async function land(input: { body: ReadableStream<Uint8Array>; descriptor: number; declared: { bytes: number; sha256: string }; signal: AbortSignal; named: string }): Promise<void> {
  const reader = input.body.getReader()
  // A read waiting on a stalled caller ends with the call: the reader is let go, which rejects it.
  const release = () => { try { reader.releaseLock() } catch { /* Released already. */ } }
  input.signal.addEventListener('abort', release, { once: true })
  const hash = createHash('sha256')
  let landed = 0
  try {
    for (;;) {
      input.signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      landed += value.byteLength
      if (landed > input.declared.bytes) throw lengthMismatch({ landed, declared: input.declared.bytes, named: input.named, more: true })
      hash.update(value)
      await writeAll(input.descriptor, value)
    }
  } catch (error) {
    input.signal.throwIfAborted()
    throw error
  } finally {
    input.signal.removeEventListener('abort', release)
    release()
  }
  if (landed !== input.declared.bytes) throw lengthMismatch({ landed, declared: input.declared.bytes, named: input.named, more: false })
  if (hash.digest('hex') !== input.declared.sha256) throw new ToolInputError(`The bytes that arrived do not hash to the sha256 the request named, so nothing was written to ${input.named}`, { code: TRANSFER_DIGEST_MISMATCH })
}

async function writeAll(descriptor: number, chunk: Uint8Array): Promise<void> {
  let written = 0
  while (written < chunk.byteLength) written += (await writeChunk(descriptor, chunk, written, chunk.byteLength - written)).bytesWritten
}

interface OpenFile { descriptor: number; size: number; signal: AbortSignal; named: string }

/** The file's digest, read from the descriptor from its start; one that shrinks or grows while it is read is refused. */
async function digestOf(file: OpenFile): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of positionalChunks(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * The file again from its start, chunk by chunk from the same descriptor, hashed as it goes: the last chunk is handed on
 * only once the whole file hashed to `sha256` and holds nothing past its size, so a file that changed since its hash
 * never completes a response under the old digest.
 */
async function* chunksOf(file: OpenFile & { sha256: string }): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256')
  let held: Uint8Array | undefined
  for await (const chunk of positionalChunks(file)) {
    if (held) yield held
    hash.update(chunk)
    held = chunk
  }
  if (hash.digest('hex') !== file.sha256 || fstatSync(file.descriptor).size !== file.size) throw changed(file.named)
  if (held) yield held
}

/** `size` bytes from position 0, each chunk its own buffer; a short read before the end, or a byte past it, means the file changed. */
async function* positionalChunks(file: OpenFile): AsyncGenerator<Uint8Array> {
  let position = 0
  while (position < file.size) {
    file.signal.throwIfAborted()
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, file.size - position))
    const { bytesRead } = await readChunk(file.descriptor, buffer, 0, buffer.byteLength, position)
    if (bytesRead === 0) throw changed(file.named)
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
  const { bytesRead } = await readChunk(file.descriptor, Buffer.allocUnsafe(1), 0, 1, file.size)
  if (bytesRead !== 0) throw changed(file.named)
}

function tooLarge(bytes: number, limit: number, outcome: string): ToolInputError {
  return new ToolInputError(`The file is ${bytes} bytes, more than the ${limit} this node copies at once (BUCKLE_MAX_TRANSFER_BYTES), so ${outcome}`, { code: TRANSFER_TOO_LARGE })
}

function parentMissing(folder: string): ToolInputError {
  return new ToolInputError(`The folder ${folder} does not exist, and a copy makes no folder: create it first, or copy into one that exists`, { code: PARENT_MISSING })
}

function lengthMismatch(input: { landed: number; declared: number; named: string; more: boolean }): ToolInputError {
  const arrived = input.more ? `More than the ${input.declared} bytes the request declared arrived` : `${input.landed} bytes arrived where the request declared ${input.declared}`
  return new ToolInputError(`${arrived}, so nothing was written to ${input.named}`, { code: TRANSFER_LENGTH_MISMATCH })
}

function changed(named: string): ToolInputError {
  return new ToolInputError(`${named} changed while it was sent, so its response was cut short; send the request again`, { code: TRANSFER_CHANGED })
}
