import type { HostEnvironment } from '../../../domain/environment.js'
import type { Program } from '../../../domain/executable.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { MAX_TRANSFER_BYTES } from '../browser/file-transfer.js'
import { findNames, listTree, patchFile, readFileEntry, writeFileEntry } from './operations.js'
import * as schemas from './schemas.js'
import { searchContent } from './search.js'
import { receivedFacts, receiveFile, sendFile, sentFacts, settleReceive, settleSend } from './transfer.js'

const PACK_ID = 'fs'
/** The node's own maximum when none is given, which a copy runs to (BUCKLE_MAX_TIMEOUT_MS). */
const DEFAULT_MAX_TIMEOUT_MS = 300_000

export interface FsPackOptions {
  paths: PathView
  runProcess: ProcessRunner
  /** The ripgrep this node runs, by its absolute path (resolveProgram); null withholds fs_search_content. */
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
      run: (input, toolContext) => readFileEntry(input, { ...context, authorizeReadTarget: toolContext.authorizeReadTarget }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_read_batch',
      description: 'Read up to 100 files in one call.',
      risk: 'read',
      tags: ['filesystem', 'batch'],
      input: schemas.readBatchInput,
      effects: input => input.paths.map(path => ({ kind: 'read_path' as const, path })),
      run: async (input, toolContext) => ({
        files: await Promise.all(input.paths.map(path => readFileEntry({ path, encoding: input.encoding }, { ...context, authorizeReadTarget: toolContext.authorizeReadTarget }))),
      }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_write',
      description: 'Write one file, replacing its contents.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.writeInput,
      effects: input => [{ kind: 'write_path', path: input.path }],
      run: (input, toolContext) => writeFileEntry(input, { ...context, authorizeWrite: toolContext.authorizeWrite }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_write_batch',
      description: 'Write up to 100 files in one call.',
      risk: 'write',
      tags: ['filesystem', 'batch'],
      input: schemas.writeBatchInput,
      effects: input => input.files.map(file => ({ kind: 'write_path' as const, path: file.path })),
      run: async (input, toolContext) => ({ files: await Promise.all(input.files.map(file => writeFileEntry(file, { ...context, authorizeWrite: toolContext.authorizeWrite }))) }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_patch',
      description: 'Apply exact text replacements to a file. Every edit must match or nothing is written.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.patchInput,
      effects: input => [{ kind: 'write_path', path: input.path }, { kind: 'read_path', path: input.path }],
      run: (input, toolContext) => patchFile(input, { ...context, authorizeWrite: toolContext.authorizeWrite }),
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
      audited: input => receivedFacts(input),
      run: (input, toolContext) => receiveFile(input, { ...transfer, authorizeWrite: toolContext.authorizeWrite, signal: toolContext.signal, file: toolContext.file, staleAfterMs: 2 * maxTimeoutMs }),
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

  const ripgrep = options.ripgrep
  if (ripgrep !== null) {
    tools.push(defineTool(PACK_ID, {
      name: 'fs_search_content',
      description: 'Search file contents with a regular expression. Respects .gitignore.',
      risk: 'read',
      tags: ['filesystem', 'search', 'regex'],
      input: schemas.searchInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: (input, toolContext) => searchContent({
        args: input,
        paths: options.paths,
        runProcess: options.runProcess,
        ripgrep,
        timeoutMs: toolContext.timeoutMs,
        signal: toolContext.signal,
        authorizeRead: toolContext.authorizeRead ?? (async () => false),
        protectedRoots: options.protectedRoots ?? [],
        ...(options.environment ? { environment: options.environment } : {}),
      }),
    }))
  }

  return {
    id: PACK_ID,
    version: '1.0.0',
    tools,
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: null,
  }
}
