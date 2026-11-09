import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grantsPath } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { createMcpHttpHandlers } from '../mcp/http.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { fixedInteraction } from './support/interaction.js'
import { asCaller, claudeCodeCall, formOf, sendAs } from './support/mcp-http-call.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The save form over HTTP: an HTTP form offers what a stdio one does, session and always included, so the HTTP face draws
// the save form as stdio does after an approval whose grant did not save, held to its own caller.

// The renames onto `rename` to fail, `count` times.
const failing = vi.hoisted(() => ({ rename: undefined as string | undefined, count: 0 }))
vi.mock('../common/adapters/replace-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return {
    ...actual,
    replaceFile: async (from: string, to: string, io?: Parameters<typeof actual.replaceFile>[2]) => {
      if (failing.rename === to && failing.count > 0) {
        failing.count -= 1
        throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' })
      }
      return actual.replaceFile(from, to, io)
    },
  }
})

const A = 'agent:token-a'
const B = 'agent:token-b'
const handlers = createMcpHttpHandlers()
const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  Object.assign(failing, { rename: undefined, count: 0 })
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

async function httpNode() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-http-save-form-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  for (const folder of [workspace, join(root, 'outside'), join(root, 'state')]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
  await openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, config.workspaceId), fallback: () => WorkspaceSettingsSchema.parse({ version: 1 }) })
    .update(current => ({ ...current, approval: { ...current.approval, forms: true } }))
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  Object.assign(failing, { rename: grantsPath(config), count: 1 })
  const send = (request: Request, actor = A) => sendAs({ handlers, workspace: { config, runtime }, request, actor })
  return { root, managed: { config, runtime }, runtime, send, waitingTokens: () => runtime.approvalService.pending().map(asked => asked.token) }
}

const accept = (key: string, content: Record<string, unknown>) => ({ [key]: { action: 'accept', content } })

describe('the save form over HTTP', () => {
  it('draws it after an approval whose grant did not save, takes it only from its own caller, as core refuses another\'s skip, and a retry saves the grant before the call runs once', async () => {
    const node = await httpNode()
    const args = { path: join(node.root, 'outside', 'note.md'), content: 'saved' }
    const asked = await node.send(claudeCodeCall({ tool: 'fs_write', args }))
    const [token] = node.waitingTokens()
    expect((formOf(asked, token!).requestedSchema.properties as Record<string, { enum?: string[] }>)['action']?.enum).toEqual(['allow_once', 'allow_session', 'allow_always', 'deny'])

    const saving = await node.send(claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'session' }) }))
    expect(Object.keys(saving.inputRequests ?? {})).toEqual([`save:${token}`])
    expect(formOf(saving, `save:${token}`).message).toContain('saving it for the session failed: permission denied')
    expect(existsSync(args.path)).toBe(false)

    const stranger = await node.send(claudeCodeCall({ tool: 'fs_write', args, responses: accept(`save:${token}`, { save: 'skip' }) }), B)
    expect(stranger.resultType).toBe('input_required')
    expect((await auditEntries(node.runtime.actions, 200)).filter(entry => entry.tool === 'approval_decision' && entry.actorId === B && entry.event === 'result').map(entry => entry.detail)).toEqual(['approver_not_allowed'])

    const ran = await node.send(claudeCodeCall({ tool: 'fs_write', args, responses: accept(`save:${token}`, { save: 'retry' }) }))
    expect(ran.isError).toBeUndefined()
    expect(readFileSync(args.path, 'utf8')).toBe('saved')
    expect(node.runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session' })])
  })

  it('lets a 2026-07-28 client run all three rounds itself, each a request of its own, and the call that asked runs once under its first requestId', async () => {
    const node = await httpNode()
    const args = { path: join(node.root, 'outside', 'client.md'), content: 'saved' }
    const shown: string[] = []
    const answers: Array<Record<string, string | boolean>> = [{ approve: true, scope: 'session' }, { save: 'retry' }]
    const client = new Client({ name: 'http-save-form-test', version: '0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } })
    client.setRequestHandler('elicitation/create', async (request) => {
      shown.push((request.params as { message: string }).message)
      return { action: 'accept', content: answers[shown.length - 1]! }
    })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), { fetch: (url, init) => asCaller(A, () => handlers.fetch(node.managed, new Request(url, init))) }))
    const result = await client.callTool({ name: 'fs_write', arguments: args })
    await client.close()

    expect(result.isError).toBeFalsy()
    expect(shown).toHaveLength(2)
    expect(shown[1]).toContain('saving it for the session failed: permission denied')
    expect(readFileSync(args.path, 'utf8')).toBe('saved')
    expect(node.runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session' })])
    const results = (await auditEntries(node.runtime.actions, 200)).filter(entry => entry.tool === 'fs_write' && entry.event === 'result')
    expect(results.map(entry => entry.outcome)).toEqual(['approval_required', 'ok'])
    expect(results[1]!.requestId).toBe(results[0]!.requestId)
  })
})
