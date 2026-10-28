import type { HostEnvironment } from '../../../domain/environment.js'
import type { Program } from '../../../domain/executable.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { MAX_TRANSFER_BYTES } from '../browser/file-transfer.js'
import { findNames, listTree, patchedSize, patchFile, readFileEntry, writeFileEntry, writtenSize } from './operations.js'
import * as schemas from './schemas.js'
import { searchBuiltin } from './builtin-search.js'
import { searchContent } from './search.js'
import { applyPatch, patchedFacts, patchedSizes, patchEffects, patchFacts, settleApplyPatch } from './apply-patch.js'
import { deletedFacts, deleteEffects, deletePaths, settleDelete } from './delete.js'
import { movedFacts, moveEffects, moveEntry, moveFacts, settleMove } from './move.js'
import { receivedFacts, receiveFile, sendFile, sentFacts, settleReceive, settleSend } from './transfer.js'

const PACK_ID = 'fs'
/** The node's own maximum when none is given, which a copy runs to (BUCKLE_MAX_TIMEOUT_MS). */
const DEFAULT_MAX_TIMEOUT_MS = 300_000

export interface FsPackOptions {
  paths: PathView
  runProcess: ProcessRunner
  /** The ripgrep this node runs, by its absolute path (resolveProgram); null runs fs_search_content's own walker instead. */
  ripgrep: Program | null
  /** Buckle's own state: a hard-linked file on its device is never read or searched (review L3 of the second re-review). */
  protectedRoots?: readonly string[]
  /** The environment ripgrep runs with (hostEnvironment); the workspace's own roots alone when absent. */
  environment?: HostEnvironment
  /** The largest file one `buckle cp` moves (BUCKLE_MAX_TRANSFER_BYTES); MAX_TRANSFER_BYTES when absent. */
  maxTransferBytes?: number
  /** The longest a call may run (BUCKLE_MAX_TIMEOUT_MS): a copy is given all of it, and a partial twice its age is swept. */
  maxTimeoutMs?: number
}

export function createFsPack(options: FsPackOptions): Pack {
  const context = { paths: options.paths, ...(options.protectedRoots ? { protectedRoots: options.protectedRoots } : {}) }
  const transfer = { ...context, maxTransferBytes: options.maxTransferBytes ?? MAX_TRANSFER_BYTES }
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS

  const tools = [
    defineTool(PACK_ID, {
      name: 'fs_read',
      description: 'Read one file. Use offset and limit to page through large files by line.',
      risk: 'read',
      tags: ['filesystem'],
      input: schemas.readInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: (input, toolContext) => readFileEntry(input, { ...context, authorizeReadTarget: toolContext.authorizeReadTarget, known: toolContext.known }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_read_batch',
      description: 'Read up to 100 files in one call.',
      risk: 'read',
      tags: ['filesystem', 'batch'],
      input: schemas.readBatchInput,
      effects: input => input.paths.map(path => ({ kind: 'read_path' as const, path })),
      run: async (input, toolContext) => ({
        files: await Promise.all(input.paths.map(path => readFileEntry({ path, encoding: input.encoding }, { ...context, authorizeReadTarget: toolContext.authorizeReadTarget, known: toolContext.known }))),
      }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_write',
      description: 'Write one file, replacing its contents.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.writeInput,
      effects: input => [{ kind: 'write_path', path: input.path }],
      written: input => [writtenSize(input)],
      run: (input, toolContext) => writeFileEntry(input, { ...context, authorizeWrite: toolContext.authorizeWrite, known: toolContext.known }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_write_batch',
      description: 'Write up to 100 files in one call.',
      risk: 'write',
      tags: ['filesystem', 'batch'],
      input: schemas.writeBatchInput,
      effects: input => input.files.map(file => ({ kind: 'write_path' as const, path: file.path })),
      written: input => input.files.map(writtenSize),
      run: async (input, toolContext) => ({ files: await Promise.all(input.files.map(file => writeFileEntry(file, { ...context, authorizeWrite: toolContext.authorizeWrite, known: toolContext.known }))) }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_patch',
      description: 'Apply exact text replacements to a file. Every edit must match or nothing is written.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.patchInput,
      effects: input => [{ kind: 'write_path', path: input.path }, { kind: 'read_path', path: input.path }],
      written: (input, current) => patchedSize(input, current),
      run: (input, toolContext) => patchFile(input, { ...context, authorizeWrite: toolContext.authorizeWrite, known: toolContext.known }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_apply_patch',
      description: 'Apply a unified diff to one or more files. Every hunk must match exactly or nothing is written.',
      risk: 'write',
      tags: ['filesystem', 'batch'],
      input: schemas.applyPatchInput,
      judge: input => settleApplyPatch(input, context),
      effects: (_input, judged) => patchEffects(judged),
      facts: (_input, judged) => patchFacts(judged),
      written: (_input, current, judged) => patchedSizes(judged, current),
      audited: input => patchedFacts(input),
      run: (_input, toolContext, judged) => applyPatch({ ...context, authorizeReadTarget: toolContext.authorizeReadTarget, authorizeWrite: toolContext.authorizeWrite, authorizeDelete: toolContext.authorizeDelete, known: toolContext.known, ...(toolContext.relocated ? { relocated: toolContext.relocated } : {}), signal: toolContext.signal }, judged),
    }),
    defineTool(PACK_ID, {
      name: 'fs_delete',
      description: 'Delete files, links, or folders. A link is removed, not followed; a folder holding entries needs recursive. Inside the workspace folder a delete runs where writes are granted, unless the owner set deletes to ask; a delete outside it, of a folder at its top, or of many entries in one call or one script asks a person.',
      risk: 'write',
      tags: ['filesystem', 'batch'],
      input: schemas.deleteInput,
      judge: input => settleDelete(input, context),
      effects: (input, judged) => deleteEffects(input, judged, options.paths),
      audited: input => deletedFacts(input),
      run: (input, toolContext, judged) => deletePaths(input, { paths: options.paths, authorizeDelete: toolContext.authorizeDelete, ...(toolContext.relocated ? { relocated: toolContext.relocated } : {}) }, judged),
    }),
    defineTool(PACK_ID, {
      name: 'fs_move',
      description: 'Move or rename a file, link, or folder. A folder to, or a trailing slash, moves into it by name. replace must match what stands at the destination: false (the default) refuses if anything does, true refuses if nothing does and otherwise replaces it, a folder with everything in it. What it replaces or takes away is judged as fs_delete judges a delete.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.moveInput,
      judge: input => settleMove(input, context),
      effects: (input, judged) => moveEffects(input, judged, options.paths),
      facts: (input, judged) => moveFacts(input, judged),
      audited: input => movedFacts(input),
      run: (input, toolContext, judged) => moveEntry(input, { paths: options.paths, authorizeDelete: toolContext.authorizeDelete, authorizeWrite: toolContext.authorizeWrite, ...(toolContext.relocated ? { relocated: toolContext.relocated } : {}) }, judged),
    }),
    defineTool(PACK_ID, {
      name: 'fs_list',
      description: 'List a directory tree. Build and dependency directories are skipped by default.',
      risk: 'read',
      tags: ['filesystem'],
      input: schemas.listInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: (input, toolContext) => listTree(input, { ...context, authorizeRead: toolContext.authorizeRead, authorizeReadTarget: toolContext.authorizeReadTarget }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_find_names',
      description: 'Find files and directories by glob pattern.',
      risk: 'read',
      tags: ['filesystem', 'search'],
      input: schemas.findInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: (input, toolContext) => findNames(input, { ...context, authorizeRead: toolContext.authorizeRead, authorizeReadTarget: toolContext.authorizeReadTarget }),
    }),
    // `buckle cp`'s two ends on the node (the copy-verb brief): judged, approved, and audited as fs_write and fs_read are,
    // run by the files route alone with the bytes beside the call, so none passes through a model.
    defineTool(PACK_ID, {
      name: 'fs_receive',
      description: 'Receive one file buckle cp sends, from the body of PUT /v1/files.',
      risk: 'write',
      tags: ['filesystem', 'transfer'],
      transfer: 'receive',
      input: schemas.receiveInput,
      timeoutMs: () => maxTimeoutMs,
      judge: input => settleReceive(input, transfer),
      effects: input => [{ kind: 'write_path', path: input.path }],
      // A copy over an existing file is a write: the destructive-write check reads the digest's byte count.
      written: input => [{ path: input.path, size: input.bytes }],
      audited: input => receivedFacts(input),
      run: (input, toolContext) => receiveFile(input, { ...transfer, authorizeWrite: toolContext.authorizeWrite, known: toolContext.known, signal: toolContext.signal, file: toolContext.file, staleAfterMs: 2 * maxTimeoutMs }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_send',
      description: 'Send one file to buckle cp, as the body of GET /v1/files.',
      risk: 'read',
      tags: ['filesystem', 'transfer'],
      transfer: 'send',
      input: schemas.sendInput,
      timeoutMs: () => maxTimeoutMs,
      facts: input => settleSend(input, transfer),
      effects: input => [{ kind: 'read_path', path: input.path }],
      audited: (input, output) => sentFacts(input, output),
      run: (input, toolContext) => sendFile(input, { ...transfer, authorizeReadTarget: toolContext.authorizeReadTarget, signal: toolContext.signal, file: toolContext.file }),
    }),
  ]

  // Offered wherever the fs pack is: ripgrep runs the search where it is installed, Buckle's own walker elsewhere (the fs-verbs brief).
  const ripgrep = options.ripgrep
  tools.push(defineTool(PACK_ID, {
    name: 'fs_search_content',
    description: 'Search file contents with a regular expression. Respects .gitignore. Where ripgrep is not installed, the result also has skipped: the files and folders left out with a reason (held, vanished, changed, unreadable, too-large, binary, timeout), at most 100, the rest counted in skippedMore. With ripgrep it has no skipped.',
    risk: 'read',
    tags: ['filesystem', 'search', 'regex'],
    input: schemas.searchInput,
    effects: input => [{ kind: 'read_path', path: input.path }],
    run: (input, toolContext) => {
      const shared = { args: input, paths: options.paths, signal: toolContext.signal, authorizeRead: toolContext.authorizeRead ?? (async () => false), protectedRoots: options.protectedRoots ?? [], ...(toolContext.known ? { known: toolContext.known } : {}) }
      if (ripgrep === null) return searchBuiltin({ ...shared, timeoutMs: toolContext.timeoutMs })
      return searchContent({ ...shared, runProcess: options.runProcess, ripgrep, timeoutMs: toolContext.timeoutMs, ...(options.environment ? { environment: options.environment } : {}) })
    },
  }))

  return {
    id: PACK_ID,
    version: '1.0.0',
    tools,
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: null,
    searcher: ripgrep === null ? 'builtin' : 'rg',
  }
}
