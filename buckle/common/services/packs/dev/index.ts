import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { discoverServers } from './discovery.js'
import { createSessionPool, ensureFileOpen } from './session.js'
import { toVirtualUris } from './virtual-paths.js'

const PACK_ID = 'dev'
const LSP_REQUEST_TIMEOUT_MS = 15_000

const languageInput = z.enum(['typescript', 'javascript', 'rust', 'go', 'python', 'c', 'cpp', 'lua'])

const positionInput = z.object({
  path: z.string().min(1),
  language: languageInput,
  line: z.number().int().min(1),
  character: z.number().int().min(0).default(0),
  /** Attach to a server found by lsp_discover instead of spawning a new one. */
  attachPort: z.number().int().min(1).max(65_535).optional(),
})

const renameInput = positionInput.extend({ newName: z.string().min(1).max(200) })
const diagnosticsInput = z.object({
  path: z.string().min(1),
  language: languageInput,
  attachPort: z.number().int().min(1).max(65_535).optional(),
})

export interface DevPackOptions {
  cwd: string
  allowHostLsp?: boolean
  paths: PathView
  runProcess: ProcessRunner
}

export function createDevPack(options: DevPackOptions): Pack {
  const pool = createSessionPool(options.cwd)

  const query = async (input: {
    method: string
    path: string
    language: z.infer<typeof languageInput>
    attachPort?: number
    position?: { line: number; character: number }
    extra?: Record<string, unknown>
  }): Promise<JsonValue> => {
    const session = await pool.get(input.language, input.attachPort ? { port: input.attachPort, host: '127.0.0.1' } : null)
    const uri = await ensureFileOpen(session, { path: options.paths.resolve(input.path), cwd: options.cwd, language: input.language })
    const answer = await session.connection.request(input.method, {
      textDocument: { uri },
      ...(input.position ? { position: { line: input.position.line - 1, character: input.position.character } } : {}),
      ...input.extra,
    }, LSP_REQUEST_TIMEOUT_MS)
    // The one place a language server's answer leaves the pack, so the one place URIs are rewritten.
    return toVirtualUris(answer as JsonValue, options.paths)
  }

  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: options.allowHostLsp === true ? null : 'Host language servers are outside shell isolation; BUCKLE_ALLOW_HOST_LSP=true explicitly permits host processes and local server attachment',
    // The language servers this pack started or attached to, which outlive single calls.
    close: () => pool.closeAll(),
    tools: [
      defineTool(PACK_ID, {
        name: 'lsp_discover',
        description: 'List language servers already running on this machine and whether each can be attached to.',
        risk: 'read',
        tags: ['lsp', 'discovery'],
        input: z.object({}),
        effects: () => [{ kind: 'process_probe' }],
        run: async (_input, context): Promise<JsonValue> => {
          const servers = await discoverServers({
            runProcess: options.runProcess,
            timeoutMs: context.timeoutMs,
            signal: context.signal,
          })
          return {
            servers: servers.map(server => ({
              pid: server.pid,
              serverId: server.serverId,
              commandLine: server.commandLine,
              attach: server.attach,
              port: server.port,
            })),
          }
        },
      }),
      defineTool(PACK_ID, {
        name: 'lsp_definition',
        description: 'Jump to where a symbol is defined.',
        risk: 'read',
        tags: ['lsp'],
        input: positionInput,
        effects: input => [{ kind: 'read_path', path: input.path }],
        run: async (input): Promise<JsonValue> => ({
          locations: await query({ method: 'textDocument/definition', ...input, position: input }),
        }),
      }),
      defineTool(PACK_ID, {
        name: 'lsp_references',
        description: 'Find every reference to the symbol at a position.',
        risk: 'read',
        tags: ['lsp'],
        input: positionInput,
        effects: input => [{ kind: 'read_path', path: input.path }],
        run: async (input): Promise<JsonValue> => ({
          locations: await query({
            method: 'textDocument/references',
            ...input,
            position: input,
            extra: { context: { includeDeclaration: true } },
          }),
        }),
      }),
      defineTool(PACK_ID, {
        name: 'lsp_hover',
        description: 'Type and documentation for the symbol at a position.',
        risk: 'read',
        tags: ['lsp'],
        input: positionInput,
        effects: input => [{ kind: 'read_path', path: input.path }],
        run: async (input): Promise<JsonValue> => ({
          hover: await query({ method: 'textDocument/hover', ...input, position: input }),
        }),
      }),
      defineTool(PACK_ID, {
        name: 'lsp_rename',
        description: 'Compute a workspace-wide rename. Returns the edits without applying them.',
        risk: 'read',
        tags: ['lsp', 'refactor'],
        input: renameInput,
        effects: input => [{ kind: 'read_path', path: input.path }],
        run: async (input): Promise<JsonValue> => ({
          workspaceEdit: await query({
            method: 'textDocument/rename',
            ...input,
            position: input,
            extra: { newName: input.newName },
          }),
        }),
      }),
      defineTool(PACK_ID, {
        name: 'lsp_diagnostics',
        description: 'Diagnostics the language server has published for a file.',
        risk: 'read',
        tags: ['lsp'],
        input: diagnosticsInput,
        effects: input => [{ kind: 'read_path', path: input.path }],
        run: async (input): Promise<JsonValue> => {
          const session = await pool.get(input.language, input.attachPort ? { port: input.attachPort, host: '127.0.0.1' } : null)
          const uri = await ensureFileOpen(session, { path: options.paths.resolve(input.path), cwd: options.cwd, language: input.language })
          return {
            uri: toVirtualUris(uri, options.paths),
            diagnostics: toVirtualUris(session.connection.diagnosticsFor(uri) as JsonValue, options.paths),
          }
        },
      }),
    ],
  }
}
