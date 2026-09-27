import { logger } from '../../../runtime/logger.js'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { ToolExecutionError } from '../../../domain/tool.js'
import { connectLspSocket, spawnLspServer, type LspConnection } from './lsp-client.js'
import { serverForLanguage } from './servers.js'

const INITIALIZE_TIMEOUT_MS = 20_000

export interface LspSession {
  connection: LspConnection
  openedFiles: Set<string>
}

/** One connection per language per workspace, reused across calls. */
export function createSessionPool(cwd: string) {
  const sessions = new Map<string, Promise<LspSession>>()

  const open = async (language: string, attach: { port: number; host: string } | null): Promise<LspSession> => {
    const known = serverForLanguage(language)
    if (!known) throw new ToolExecutionError(`No known language server for ${language}`, { code: 'LSP_UNSUPPORTED' })

    const connection = attach
      ? await connectLspSocket(attach)
      : spawnLspServer({ command: known.binaries[0] ?? language, args: known.spawnArgs, cwd })

    try {
      await connection.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(cwd).href,
        workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: 'workspace' }],
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            hover: { contentFormat: ['plaintext', 'markdown'] },
            rename: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
          },
        },
      }, INITIALIZE_TIMEOUT_MS)
      connection.notify('initialized', {})
    } catch (error) { connection.close(); throw error }

    return { connection, openedFiles: new Set<string>() }
  }

  return {
    get(language: string, attach: { port: number; host: string } | null): Promise<LspSession> {
      const key = JSON.stringify([language, attach?.host ?? null, attach?.port ?? null])
      const existing = sessions.get(key)
      if (existing) return existing
      const created = open(language, attach).catch(error => {
        if (sessions.get(key) === created) sessions.delete(key)
        throw error
      })
      sessions.set(key, created)
      return created
    },

    closeAll(): void {
      for (const session of sessions.values()) session.then(({ connection }) => connection.close()).catch(() => logger.warn('Language server initialization failed during shutdown'))
      sessions.clear()
    },
  }
}

/** A server only answers about documents it has been told about. */
export async function ensureFileOpen(session: LspSession, input: { path: string; cwd: string; language: string }): Promise<string> {
  const absolute = resolve(input.cwd, input.path)
  const uri = pathToFileURL(absolute).href
  if (session.openedFiles.has(uri)) return uri

  session.connection.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: input.language, version: 1, text: await readFile(absolute, 'utf8') },
  })
  session.openedFiles.add(uri)
  return uri
}
