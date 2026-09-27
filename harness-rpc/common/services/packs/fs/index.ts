import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { findNames, listTree, patchFile, readFileEntry, writeFileEntry } from './operations.js'
import * as schemas from './schemas.js'
import { searchContent } from './search.js'

const PACK_ID = 'fs'

export interface FsPackOptions {
  paths: PathView
  runProcess: ProcessRunner
  hasRipgrep: boolean
}

export function createFsPack(options: FsPackOptions): Pack {
  const context = { paths: options.paths }

  const tools = [
    defineTool(PACK_ID, {
      name: 'fs_read',
      description: 'Read one file. Use offset and limit to page through large files by line.',
      risk: 'read',
      tags: ['filesystem'],
      input: schemas.readInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: input => readFileEntry(input, context),
    }),
    defineTool(PACK_ID, {
      name: 'fs_read_batch',
      description: 'Read up to 100 files in one call.',
      risk: 'read',
      tags: ['filesystem', 'batch'],
      input: schemas.readBatchInput,
      effects: input => input.paths.map(path => ({ kind: 'read_path' as const, path })),
      run: async input => ({
        files: await Promise.all(input.paths.map(path => readFileEntry({ path, encoding: input.encoding }, context))),
      }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_write',
      description: 'Write one file, replacing its contents.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.writeInput,
      effects: input => [{ kind: 'write_path', path: input.path }],
      run: input => writeFileEntry(input, context),
    }),
    defineTool(PACK_ID, {
      name: 'fs_write_batch',
      description: 'Write up to 100 files in one call.',
      risk: 'write',
      tags: ['filesystem', 'batch'],
      input: schemas.writeBatchInput,
      effects: input => input.files.map(file => ({ kind: 'write_path' as const, path: file.path })),
      run: async input => ({ files: await Promise.all(input.files.map(file => writeFileEntry(file, context))) }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_patch',
      description: 'Apply exact text replacements to a file. Every edit must match or nothing is written.',
      risk: 'write',
      tags: ['filesystem'],
      input: schemas.patchInput,
      effects: input => [{ kind: 'write_path', path: input.path }, { kind: 'read_path', path: input.path }],
      run: input => patchFile(input, context),
    }),
    defineTool(PACK_ID, {
      name: 'fs_list',
      description: 'List a directory tree. Build and dependency directories are skipped by default.',
      risk: 'read',
      tags: ['filesystem'],
      input: schemas.listInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: (input, toolContext) => listTree(input, { ...context, authorizeRead: toolContext.authorizeRead }),
    }),
    defineTool(PACK_ID, {
      name: 'fs_find_names',
      description: 'Find files and directories by glob pattern.',
      risk: 'read',
      tags: ['filesystem', 'search'],
      input: schemas.findInput,
      effects: input => [{ kind: 'read_path', path: input.path }],
      run: (input, toolContext) => findNames(input, { ...context, authorizeRead: toolContext.authorizeRead }),
    }),
  ]

  if (options.hasRipgrep) {
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
        timeoutMs: toolContext.timeoutMs,
        signal: toolContext.signal,
        authorizeRead: toolContext.authorizeRead ?? (async () => false),
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
