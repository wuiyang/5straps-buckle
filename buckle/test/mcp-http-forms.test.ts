import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileVersion } from '../common/adapters/json-file-store.js'
import { approvalsPath } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import type { ApprovalHold } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { createMcpHttpHandlers } from '../mcp/http.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { CLAUDE_CODE_HTTP_MCP } from './support/claude-code-http-mcp.js'
import { asCaller, claudeCodeCall, formOf, sendAs, type Form } from './support/mcp-http-call.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The HTTP MCP face draws forms inside a tool call for a client on the 2026-07-28 revision, while the forms setting is
// on: the same input_required round trip as stdio, offering what a stdio form offers. Its answers come in as http-forms,
// which decide only the asks their own caller raised. Claude Code's HTTP client was recorded at that revision
// (fixtures/claude-code-http-mcp.json); the probe saw no answer round, so these tests build its tools/call from the
// envelope it sent.

const PROTOCOL = '2026-07-28'
const A = 'agent:token-a'
const B = 'agent:token-b'
const handlers = createMcpHttpHandlers()
const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** No terminal, a hold only while this process asks: a gated call answers at once. */
const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

async function httpNode(input: { forms: boolean; environment?: Record<string, string>; hold?: ApprovalHold }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-http-forms-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  for (const folder of [workspace, join(root, 'outside'), join(root, 'state')]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000', ...input.environment })
  const settings = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, config.workspaceId), fallback: () => WorkspaceSettingsSchema.parse({ version: 1 }) })
  await settings.update(current => ({ ...current, approval: { ...current.approval, forms: input.forms } }))
  const runtime = await createRuntime({ config, interaction: fixedInteraction(input.hold === undefined ? NOBODY : { ...NOBODY, hold: input.hold }) })
  runtimes.push(runtime)
  const managed = { config, runtime }
  const waitingTokens = () => runtime.approvalService.pending().map(asked => asked.token)
  const decisions = async () => (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'approval_decision')
  return { root, workspace, config, runtime, managed, waitingTokens, decisions }
}

type HttpNode = Awaited<ReturnType<typeof httpNode>>

const send = (node: HttpNode, request: Request, actor = A) => sendAs({ handlers, workspace: node.managed, request, actor })
const schemaOf = (form: Form) => form.requestedSchema.properties as Record<string, { enum?: string[] }>
const accept = (token: string, content: Record<string, unknown>) => ({ [token]: { action: 'accept', content } })
const writeOutside = (node: HttpNode, name = 'note.md') => ({ path: join(node.root, 'outside', name), content: 'from the agent' })

describe('the HTTP MCP face, forms on', () => {
  it('draws one form per ask for Claude Code\'s recorded 2026-07-28 envelope, and the call sent again with a once answer runs, recorded under its caller', async () => {
    const node = await httpNode({ forms: true })
    const args = writeOutside(node)
    const asked = await send(node, claudeCodeCall({ tool: 'fs_write', args }))
    const [token] = node.waitingTokens()
    expect(asked.resultType).toBe('input_required')
    expect(Object.keys(asked.inputRequests ?? {})).toEqual([token])
    expect(formOf(asked, token!).message).toContain(JSON.stringify(args.path))

    const ran = await send(node, claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'once' }) }))
    expect(ran.isError).toBeUndefined()
    expect(ran.resultType).not.toBe('input_required')
    expect(readFileSync(args.path, 'utf8')).toBe('from the agent')
    expect(node.waitingTokens()).toEqual([])
    expect((await node.decisions()).filter(entry => entry.event === 'attempt')).toEqual([expect.objectContaining({ actorId: A, args: expect.objectContaining({ token, outcome: 'approve', scope: 'once', source: SOURCES['http-forms'] }) })])
  })

  it('lets a 2026-07-28 client fill the form and send the call again itself: @modelcontextprotocol/client 2.0.0', async () => {
    const node = await httpNode({ forms: true })
    const args = writeOutside(node, 'client.md')
    const shown: Form[] = []
    const client = new Client({ name: 'http-forms-test', version: '0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: PROTOCOL } } })
    client.setRequestHandler('elicitation/create', async (request) => {
      shown.push(request.params as Form)
      return { action: 'accept', content: { approve: true, scope: 'once' } }
    })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), { fetch: (url, init) => asCaller(A, () => handlers.fetch(node.managed, new Request(url, init))) }))
    const result = await client.callTool({ name: 'fs_write', arguments: args })
    await client.close()

    expect(result.isError).toBeFalsy()
    expect(shown).toHaveLength(1)
    expect(shown[0]!.message).toContain(JSON.stringify(args.path))
    expect(readFileSync(args.path, 'utf8')).toBe('from the agent')
  })

  it('offers a non-floor ask every scope it offers, as a stdio form does, and a session answer runs the call and saves its own caller\'s grant', async () => {
    const node = await httpNode({ forms: true })
    const args = writeOutside(node)
    const asked = await send(node, claudeCodeCall({ tool: 'fs_write', args }))
    const [token] = node.waitingTokens()
    expect(schemaOf(formOf(asked, token!))['scope']?.enum).toEqual(['once', 'session', 'always'])
    expect(formOf(asked, token!).message).not.toContain('this form')

    const ran = await send(node, claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'session' }) }))
    expect(ran.isError).toBeUndefined()
    expect(ran.resultType).not.toBe('input_required')
    expect(readFileSync(args.path, 'utf8')).toBe('from the agent')
    expect(node.runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session', sessionId: 'mcp', actor: A })])
    expect((await node.decisions()).filter(entry => entry.event === 'result').map(entry => [entry.outcome, (entry.args as { assurance?: string }).assurance])).toEqual([['ok', 'local']])

    const again = await send(node, claudeCodeCall({ tool: 'fs_write', args: { ...args, content: 'again' } }))
    expect(again.resultType).not.toBe('input_required')
    expect(readFileSync(args.path, 'utf8')).toBe('again')
  })

  it('draws a floor ask\'s approval as a stdio form does, and a once approval from its own caller runs the call', async () => {
    const node = await httpNode({ forms: true, environment: { BUCKLE_DELETE_IN_WORKSPACE: 'ask' } })
    await node.runtime.grants.grant({ sessionId: 'mcp', rule: 'write_scope', subject: node.runtime.paths().root, scope: 'always' })
    writeFileSync(join(node.workspace, 'notes.txt'), 'delete me')
    const args = { paths: ['notes.txt'] }
    const asked = await send(node, claudeCodeCall({ tool: 'fs_delete', args }))
    const [token] = node.waitingTokens()
    expect(node.runtime.approvalService.waiting().map(ask => ask.floor)).toEqual([true])
    const form = formOf(asked, token!)
    expect(schemaOf(form)['approve']).toBeDefined()
    expect(schemaOf(form)['scope']?.enum).toEqual(['once', 'session', 'always'])
    expect(form.message).not.toContain('this form only denies it')

    const ran = await send(node, claudeCodeCall({ tool: 'fs_delete', args, responses: accept(token!, { approve: true, scope: 'once' }) }))
    expect(ran.isError).toBeUndefined()
    expect(existsSync(join(node.workspace, 'notes.txt'))).toBe(false)
    expect(node.waitingTokens()).toEqual([])
  })

  it('draws the forms again at once for a call sent again with its form dismissed: no form holds the call for the node', async () => {
    const node = await httpNode({ forms: true, hold: 'grace', environment: { BUCKLE_DELETE_IN_WORKSPACE: 'ask' } })
    await node.runtime.grants.grant({ sessionId: 'mcp', rule: 'write_scope', subject: node.runtime.paths().root, scope: 'always' })
    writeFileSync(join(node.workspace, 'notes.txt'), 'keep me')
    const args = { paths: ['notes.txt'] }
    await send(node, claudeCodeCall({ tool: 'fs_delete', args }))
    const [token] = node.waitingTokens()

    const resent = await send(node, claudeCodeCall({ tool: 'fs_delete', args, responses: { [token!]: { action: 'decline' } } }))
    expect(resent.resultType).toBe('input_required')
    expect(Object.keys(resent.inputRequests ?? {})).toEqual([token])
    expect(node.waitingTokens()).toEqual([token])
    expect(existsSync(join(node.workspace, 'notes.txt'))).toBe(true)
  })

  it('holds a form answer to its own caller: another token\'s answer to the ask is not read, and its own caller\'s runs the call', async () => {
    const node = await httpNode({ forms: true })
    const args = writeOutside(node)
    await send(node, claudeCodeCall({ tool: 'fs_write', args }))
    const [token] = node.waitingTokens()

    await send(node, claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'once' }) }), B)
    expect(node.waitingTokens()).toContain(token)
    expect(existsSync(args.path)).toBe(false)
    expect(await node.decisions()).toEqual([])

    expect((await send(node, claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'once' }) }))).isError).toBeUndefined()
    expect(readFileSync(args.path, 'utf8')).toBe('from the agent')
  })

  it('reads no answer naming no ask its caller has waiting: many unknown keys and another token\'s ask make no decision record and leave the approvals file untouched', async () => {
    const node = await httpNode({ forms: true })
    await send(node, claudeCodeCall({ tool: 'fs_write', args: writeOutside(node) }))
    const [token] = node.waitingTokens()
    writeFileSync(join(node.workspace, 'notes.txt'), 'read me')
    const before = fileVersion(approvalsPath(node.config))
    const once = { action: 'accept', content: { approve: true, scope: 'once' } }
    const responses = Object.fromEntries([token!, ...Array.from({ length: 300 }, () => randomUUID())].map(key => [key, once]))

    const read = await send(node, claudeCodeCall({ tool: 'fs_read', args: { path: 'notes.txt' }, responses }), B)
    expect(read.isError).toBeUndefined()
    expect(read.content?.[0]?.text).toContain('read me')
    expect(await node.decisions()).toEqual([])
    expect(fileVersion(approvalsPath(node.config))).toBe(before)
    expect(node.waitingTokens()).toEqual([token])
  })

  it('gives a 2025-era client the relay text: Claude Code\'s recorded fallback initialize, then a tools/call at 2025-11-25', async () => {
    const node = await httpNode({ forms: true })
    const { headers, body } = CLAUDE_CODE_HTTP_MCP.legacy.initialize
    const legacy = { ...headers, 'mcp-protocol-version': body.params.protocolVersion }
    const initialized = await asCaller(A, () => handlers.fetch(node.managed, new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body: JSON.stringify(body) })))
    expect(initialized.status).toBe(200)
    await initialized.text()

    const args = writeOutside(node)
    const asked = await send(node, new Request('http://127.0.0.1/mcp', { method: 'POST', headers: legacy, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_write', arguments: args } }) }))
    expect(asked.resultType).toBeUndefined()
    expect(asked.structuredContent?.outcome).toBe('approval_required')
    expect(asked.content?.[0]?.text).toContain('This call needs approval')
  })

  it('closes its forms with the runtime\'s approvals: an answer sent after decides nothing, and the call does not run', async () => {
    const node = await httpNode({ forms: true })
    const args = writeOutside(node)
    await send(node, claudeCodeCall({ tool: 'fs_write', args }))
    const [token] = node.waitingTokens()
    await node.runtime.approvalService.close()

    expect((await send(node, claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'once' }) }))).resultType).toBe('input_required')
    expect(await node.decisions()).toEqual([])
    expect(node.waitingTokens()).toEqual([token])
    expect(existsSync(args.path)).toBe(false)
  })

  it('opens one forms backend per workspace runtime, under the HTTP forms source', async () => {
    const node = await httpNode({ forms: true })
    const opening = vi.spyOn(node.runtime.approvalService, 'openFormsBackend')
    for (const name of ['one.md', 'two.md']) await send(node, claudeCodeCall({ tool: 'fs_write', args: writeOutside(node, name) }))
    expect(opening).toHaveBeenCalledTimes(1)
    expect(opening).toHaveBeenCalledWith(expect.anything(), 'http')
  })
})

describe('the HTTP MCP face, forms off', () => {
  it('gives Claude Code\'s envelope the relay text, and reads no answer its call carries', async () => {
    const node = await httpNode({ forms: false })
    const args = writeOutside(node)
    expect((await send(node, claudeCodeCall({ tool: 'fs_write', args }))).structuredContent?.outcome).toBe('approval_required')
    const [token] = node.waitingTokens()
    const answers = vi.spyOn(node.runtime.approvalService, 'answer')
    expect((await send(node, claudeCodeCall({ tool: 'fs_write', args, responses: accept(token!, { approve: true, scope: 'once' }) }))).structuredContent?.outcome).toBe('approval_required')
    expect(answers).not.toHaveBeenCalled()
    expect(node.waitingTokens()).toEqual([token])
    expect(existsSync(args.path)).toBe(false)
  })
})
