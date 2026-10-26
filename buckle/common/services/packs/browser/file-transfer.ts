import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, read, readdirSync, rmSync, statSync, write } from 'node:fs'
import { basename, dirname, join } from 'pathe'
import { promisify } from 'node:util'
import { openRealDirectory, withFileBeneathAsync } from '../../../adapters/beneath.js'
import { replaceBeneath, sweepPartials } from '../../../adapters/replace-beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { ToolInputError, type ToolContext } from '../../../domain/tool.js'
import { isMissingPathError } from '../../invocation/real-path.js'
import { judgedPath } from '../judged-path.js'
import { isPlainName } from '../../../domain/paths.js'

/**
 * agent-browser opens the paths it is given with ordinary, link-following opens, so it is never handed
 * a workspace path (review items 0 and 4 of the proof-of-possession fixes). Each file argument is
 * judged where it lands and swapped for a file in a private transfer directory: an upload is copied
 * there from its target, opened beneath a parent reached without following a link, and a screenshot,
 * PDF or download written there is copied beside its target the same way once the command succeeds,
 * and renamed onto it once whole (replaceBeneath).
 * Copies are bounded by MAX_TRANSFER_BYTES and awaited chunk by chunk, so the call's signal (its
 * timeout, its caller, the shutdown) stops one and no copy holds the node (review L4 of the second
 * proof-of-possession re-review).
 */
export interface FileTransfer {
  /** What agent-browser is handed in place of one of the agent's file arguments; undefined for any other argument. */
  argument(named: string): string | undefined
  /** Copies each file agent-browser wrote to the target its permission check judged. */
  deliver(): Promise<void>
  /** agent-browser's output with each transfer path named as the agent named it. */
  shown(text: string): string
  close(): void
}

interface Transferred { named: string; target: string; staged: string; kind: 'read' | 'write' }

const CHUNK_BYTES = 1_048_576
/** The largest file a browser command takes in or hands back: 100 MiB, larger than any fs tool reads or writes. */
export const MAX_TRANSFER_BYTES = 100 * 1_048_576
const TRANSFER_PREFIX = 'transfer-'
const readChunk = promisify(read)
const writeChunk = promisify(write)

export async function prepareTransfer(input: {
  /** The pack's private session directory, which no tool reaches. */
  directory: string
  paths: PathView
  reads: string[]
  writes: string[]
  context: Pick<ToolContext, 'authorizeReadTarget' | 'authorizeWrite' | 'signal'>
  /** Buckle's protected roots: an upload of a hard-linked file on their device is refused (review L3 of the second re-review). */
  protectedRoots: readonly string[]
  /** How old a partial delivery beside a target is before it is removed: twice the longest a call may run, as sweepTransfers. */
  staleAfterMs: number
}): Promise<FileTransfer> {
  const directory = join(input.directory, `${TRANSFER_PREFIX}${randomUUID()}`)
  const files = new Map<string, Transferred>()
  const signal = input.context.signal
  try {
    for (const [kind, names] of [['read', input.reads], ['write', input.writes]] as const) {
      for (const named of names) {
        if (files.has(named)) continue
        const target = judgedPath({ named, kind, paths: input.paths, context: input.context })
        const slot = join(directory, String(files.size))
        mkdirSync(slot, { recursive: true, mode: 0o700 })
        const file = { named, target, staged: join(slot, basename(target)), kind }
        if (kind === 'read') await withFileBeneathAsync(target, { flags: constants.O_RDONLY, shown: named, protectedRoots: input.protectedRoots, roots: input.paths.reachableRoots }, source => copyInto({ source, staged: file.staged, named, signal }))
        files.set(named, file)
      }
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    argument: named => files.get(named)?.staged,
    async deliver() {
      for (const file of files.values()) if (file.kind === 'write') await deliver(file, signal, input.staleAfterMs)
    },
    shown(text) {
      let shown = text
      for (const file of files.values()) {
        shown = shown.replaceAll(JSON.stringify(file.staged).slice(1, -1), JSON.stringify(file.named).slice(1, -1)).replaceAll(file.staged, file.named)
      }
      return shown
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}

/**
 * Removes transfer directories a node that stopped mid-call left behind: those older than twice the
 * longest a call may run, which no call can still be using, whichever process started it.
 */
export function sweepTransfers(input: { directory: string; staleAfterMs: number; now?: number }): void {
  let names: string[]
  try { names = readdirSync(input.directory) } catch { return }
  const now = input.now ?? Date.now()
  for (const name of names.filter(entry => entry.startsWith(TRANSFER_PREFIX) && isPlainName(entry))) {
    const path = join(input.directory, name)
    try {
      if (now - statSync(path).mtimeMs > input.staleAfterMs) rmSync(path, { recursive: true, force: true })
    } catch { /* Gone meanwhile, or another process sweeps it. */ }
  }
}

/**
 * A file agent-browser left in the transfer directory goes to its judged target; one it did not write creates nothing.
 * Nothing is made once the call's signal has fired, and the copy goes into a new name beside the target (replaceBeneath),
 * renamed onto it only once whole: truncating the target first left an empty screenshot in the workspace when the
 * caller had gone while the call waited for an approval (owner's live node, 2026-10-14).
 */
async function deliver(file: Transferred, signal: AbortSignal, staleAfterMs: number): Promise<void> {
  signal.throwIfAborted()
  let source: number
  try {
    source = openSync(file.staged, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  try {
    const info = fstatSync(source)
    if (!info.isFile()) throw new ToolInputError(`agent-browser did not write a regular file for ${file.named}`)
    if (info.size > MAX_TRANSFER_BYTES) throw tooLarge(file.named)
    signal.throwIfAborted()
    const directory = openRealDirectory(dirname(file.target), { create: true, refusal: { shown: file.named } })
    try {
      sweepPartials(directory, staleAfterMs)
      // Copied into a new name beside the target and renamed onto it once whole (replaceBeneath).
      await replaceBeneath({ directory, name: basename(file.target), named: file.named, signal, fill: target => copy({ source, target, named: file.named, signal }) })
    } finally { directory.close() }
  } finally { closeSync(source) }
}

async function copyInto(input: { source: number; staged: string; named: string; signal: AbortSignal }): Promise<void> {
  if (fstatSync(input.source).size > MAX_TRANSFER_BYTES) throw tooLarge(input.named)
  const target = openSync(input.staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await copy({ ...input, target }) } finally { closeSync(target) }
}

/** Chunk by chunk, awaited, checking the call's signal before each read and the cap after it, so a file that grows is stopped too. */
async function copy(input: { source: number; target: number; named: string; signal: AbortSignal }): Promise<void> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  let copied = 0
  for (;;) {
    input.signal.throwIfAborted()
    const { bytesRead } = await readChunk(input.source, buffer, 0, CHUNK_BYTES, null)
    if (bytesRead === 0) return
    copied += bytesRead
    if (copied > MAX_TRANSFER_BYTES) throw tooLarge(input.named)
    let written = 0
    while (written < bytesRead) written += (await writeChunk(input.target, buffer, written, bytesRead - written)).bytesWritten
  }
}

function tooLarge(named: string): ToolInputError {
  return new ToolInputError(`${named} is larger than the ${MAX_TRANSFER_BYTES / 1_048_576} MiB a browser command transfers, so it was not copied`)
}
