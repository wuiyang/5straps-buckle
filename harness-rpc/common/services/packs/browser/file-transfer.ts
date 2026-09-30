import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { withFileBeneath } from '../../../adapters/beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { ToolInputError, type ToolContext } from '../../../domain/tool.js'
import { isMissingPathError, resolveTarget } from '../../invocation/real-path.js'

/**
 * agent-browser opens the paths it is given with ordinary, link-following opens, so it is never handed
 * a workspace path (review items 0 and 4 of the proof-of-possession fixes). Each file argument is
 * judged where it lands and swapped for a file in a private transfer directory: an upload is copied
 * there from its target, opened beneath a parent reached without following a link, and a screenshot,
 * PDF or download written there is copied to its target the same way once the command succeeds.
 */
export interface FileTransfer {
  /** What agent-browser is handed in place of one of the agent's file arguments; undefined for any other argument. */
  argument(named: string): string | undefined
  /** Copies each file agent-browser wrote to the target its permission check judged. */
  deliver(): void
  /** agent-browser's output with each transfer path named as the agent named it. */
  shown(text: string): string
  close(): void
}

interface Transferred { named: string; target: string; staged: string; kind: 'read' | 'write' }

const CHUNK_BYTES = 1_048_576

export function prepareTransfer(input: {
  /** The pack's private session directory, which no tool reaches. */
  directory: string
  paths: PathView
  reads: string[]
  writes: string[]
  context: Pick<ToolContext, 'authorizeReadTarget' | 'authorizeWrite'>
}): FileTransfer {
  const directory = join(input.directory, `transfer-${randomUUID()}`)
  const files = new Map<string, Transferred>()
  try {
    for (const [kind, names] of [['read', input.reads], ['write', input.writes]] as const) {
      for (const named of names) {
        if (files.has(named)) continue
        const target = judgedTarget({ named, kind, paths: input.paths, context: input.context })
        const slot = join(directory, String(files.size))
        mkdirSync(slot, { recursive: true, mode: 0o700 })
        const file = { named, target, staged: join(slot, basename(target)), kind }
        if (kind === 'read') withFileBeneath(target, { flags: constants.O_RDONLY, shown: named }, source => copyInto(source, file.staged))
        files.set(named, file)
      }
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    argument: named => files.get(named)?.staged,
    deliver() {
      for (const file of files.values()) if (file.kind === 'write') deliver(file)
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

function judgedTarget(input: { named: string; kind: 'read' | 'write'; paths: PathView; context: Pick<ToolContext, 'authorizeReadTarget' | 'authorizeWrite'> }): string {
  const target = resolveTarget(input.paths.resolve(input.named))
  const authorize = input.kind === 'read' ? input.context.authorizeReadTarget : input.context.authorizeWrite
  if (authorize && !authorize(target)) throw new ToolInputError(`${input.named} now resolves to a place its permission check did not see; send the call again`, { code: 'PERMISSION_DENIED' })
  return target
}

/** A file agent-browser left in the transfer directory goes to its judged target; one it did not write creates nothing. */
function deliver(file: Transferred): void {
  let source: number
  try {
    source = openSync(file.staged, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  try {
    if (!fstatSync(source).isFile()) throw new ToolInputError(`agent-browser did not write a regular file for ${file.named}`)
    withFileBeneath(file.target, { flags: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, createParents: true, shown: file.named }, target => copy(source, target))
  } finally { closeSync(source) }
}

function copyInto(source: number, staged: string): void {
  const target = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { copy(source, target) } finally { closeSync(target) }
}

function copy(source: number, target: number): void {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  for (let read = readSync(source, buffer, 0, CHUNK_BYTES, null); read > 0; read = readSync(source, buffer, 0, CHUNK_BYTES, null)) {
    let written = 0
    while (written < read) written += writeSync(target, buffer, written, read - written)
  }
}
