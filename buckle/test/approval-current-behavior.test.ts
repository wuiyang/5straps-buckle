import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationScope, runInScope, type RequestCli } from '@5straps/runtime'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { challengeBytes } from '@5straps/protocol/signed-request'
import { CLIENT_CAPABILITIES_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkUrlCommand } from '../cli/check-url.js'
import { RECORDED_BEFORE_NOTE } from '../common/domain/approval/recorded-before-note.js'
import { commandMarks, FILE_FLOOR_MARKS, PLAIN_MARKS } from '../common/domain/permission/decision.js'
import type { PermissionEngine } from '../common/domain/permission/engine.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { actionsPath, approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { SOURCES, type ApprovalSource } from '../common/types/ports/approval-source.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createMcpServer } from '../mcp/server.js'
import { openForms } from '../mcp/open-forms.js'
import { fixedInteraction } from './support/interaction.js'
import { captureWebhook } from './support/webhook.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// Today's approval behaviors, driven through the invoker, the approval service, and the MCP faces, so each slice of the
// approval backend design shows what it keeps and what it changes.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const close of closers.splice(0)) await close()
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** No terminal, a hold only while this process asks: a gated call answers approval_required at once. */
const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

/** A serve terminal that answers each question with the next choice, then denies every later one. */
function terminal(choices: string[]): Interaction & { asked: string[] } {
  const asked: string[] = []
  const requestCli: RequestCli = async (request) => {
    asked.push(request.id)
    return { status: 'answered', requestId: request.id, answer: { choice: choices[asked.length - 1] ?? 'deny' } }
  }
  return { requestCli, hold: 'grace', asked }
}

async function node(input: { interaction?: Interaction; webhook?: boolean; shell?: boolean; forms?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-current-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const webhook = input.webhook ? await captureWebhook() : undefined
  if (webhook) closers.push(webhook.close)
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'current-agent-token', BUCKLE_ADMIN_TOKEN: 'current-admin-token',
    BUCKLE_APPROVAL_TIMEOUT_MS: '60000', BUCKLE_DELETE_IN_WORKSPACE: 'ask',
    ...(input.shell ? { BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell' } : { BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }),
    ...(webhook ? { BUCKLE_APPROVAL_WEBHOOK: webhook.url } : {}),
    ...(input.forms ? { BUCKLE_APPROVAL_FORMS: 'true' } : {}),
  })
  const runtime = await createRuntime({ config, interaction: fixedInteraction(input.interaction ?? NOBODY) })
  runtimes.push(runtime)
  let sequence = 0
  const call = (tool: string, args: JsonObject, options: { sessionId?: string; requestId?: string; tokens?: string[] } = {}): Promise<InvokeResponse> =>
    runtime.invoke({ request: { requestId: options.requestId ?? `call-${++sequence}`, tool, args, approvalTokens: options.tokens ?? [] }, sessionId: options.sessionId ?? 's' })
  const answer = (token: string, decision: { approved?: boolean; scope?: 'once' | 'session' | 'always'; subject?: string } = {}, source: ApprovalSource = SOURCES.cli) =>
    runtime.approvalService.answer({ decision: { token, approved: decision.approved ?? true, scope: decision.scope ?? 'once', ...(decision.subject === undefined ? {} : { subject: decision.subject }) }, source })
  return { root, workspace, config, runtime, webhook, call, answer, folder: runtime.paths().root }
}

const tokensOf = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals.map(approval => approval.token) : [])

interface ToolResult { isError?: boolean; structuredContent?: { outcome?: string } }

/** A tool the MCP server registered, called as a host that elicits calls it, with the answers a retry carries. */
function mcpTool(server: McpServer, tool: string) {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<ToolResult> }> })._registeredTools
  const envelope = { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } }
  return (args: JsonObject, responses?: Record<string, unknown>) => tools[tool]!.handler(args, { mcpReq: { id: 1, method: 'tools/call', requestState: () => undefined, envelope, ...(responses ? { inputResponses: responses } : {}) } } as unknown as ServerContext)
}

const accepted = (token: string, content: { approve: boolean; scope: 'once' | 'session' | 'always' }) => ({ [token]: { action: 'accept', content } })

/**
 * A node behind the MCP server a face builds: stdio trusts the answers its host's forms carry, with the node's forms
 * setting on, and HTTP does not.
 */
async function mcpNode(input: { trusted: boolean }) {
  const context = await node({ forms: input.trusted })
  const server = createMcpServer({ runtime: context.runtime, serverName: 'current-mcp', version: '0', followToolChanges: false, ...(input.trusted ? { forms: openForms(context.runtime, { face: 'stdio' }) } : {}) })
  return { ...context, tool: (name: string) => mcpTool(server, name), waiting: () => context.runtime.approvalService.pending().map(request => request.token) }
}

describe('a serve terminal answer', () => {
  it('grants the folder for the session with no expiry, tells the webhook, and records the decision in the workspace\'s audit log', async () => {
    const asker = terminal(['session'])
    const { runtime, webhook, call, folder } = await node({ interaction: asker, webhook: true })

    expect(await call('fs_write', { path: 'one/a.md', content: 'a' })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_write', { path: 'one/b.md', content: 'b' })).toMatchObject({ outcome: 'ok' })

    expect(asker.asked).toHaveLength(1)
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', subject: join(folder, 'one'), scope: 'session', sessionId: 's', expiresAt: null })])
    await vi.waitFor(() => expect(webhook!.notices.filter(notice => notice.event === 'answered')).toEqual([expect.objectContaining({ event: 'answered', scope: 'session' })]))
    const entries = await auditEntries(runtime.actions, 50)
    expect(new Set(entries.map(entry => entry.tool))).toEqual(new Set(['fs_write', 'approval_decision']))
    expect(entries.filter(entry => entry.tool === 'fs_write' && entry.event === 'result').map(entry => [entry.outcome, entry.asked, entry.approvedBy])).toEqual([
      ['ok', ['write_scope'], ['write_scope']],
      ['ok', undefined, ['write_scope']],
    ])
    expect(entries.filter(entry => entry.tool === 'approval_decision').map(entry => [entry.event, entry.outcome, entry.args])).toEqual([
      ['attempt', 'started', expect.objectContaining({ outcome: 'approve', scope: 'session', source: SOURCES.terminal, proof: 'none' })],
      ['result', 'ok', expect.objectContaining({ outcome: 'approve', scope: 'session', source: SOURCES.terminal, assurance: 'local' })],
    ])
  })

  it('approving once runs the call once, and denying the next refuses it as declined', async () => {
    const asker = terminal(['once', 'deny'])
    const { runtime, call } = await node({ interaction: asker })

    expect(await call('fs_write', { path: 'one/a.md', content: 'a' })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_write', { path: 'one/a.md', content: 'again' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Approval was declined') } })

    expect(asker.asked).toHaveLength(2)
    expect(runtime.grants.list()).toEqual([])
    expect(runtime.approvals.unspent('s')).toEqual([])
  })
})

describe('an ask nobody is at a terminal for', () => {
  it('answers approval_required at once; a once answered later is spent by the retry without its token, in that session alone', async () => {
    const { runtime, call, answer } = await node()
    const asked = await call('fs_write', { path: 'one/a.md', content: 'a' })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', offeredScopes: ['once', 'session', 'always'] }] })
    expect(await answer(tokensOf(asked)[0]!)).toMatchObject({ ok: true, asked: { rule: 'write_scope' } })

    expect((await call('fs_write', { path: 'one/a.md', content: 'a' }, { sessionId: 'other' })).outcome).toBe('approval_required')
    expect(await call('fs_write', { path: 'one/a.md', content: 'a' })).toMatchObject({ outcome: 'ok' })
    expect((await call('fs_write', { path: 'one/a.md', content: 'a' })).outcome).toBe('approval_required')
    expect(runtime.grants.list()).toEqual([])
  })

  it('keeps a once answered later from another actor in the same session, and spends it on the asker\'s retry', async () => {
    const { runtime, call, answer } = await node()
    const owner = Symbol('current-actors')
    const as = <T>(actor: string, run: () => Promise<T>) => runInScope(createOperationScope({ owner, context: { actor } }), run)
    const asked = await as('agent:one', () => call('fs_write', { path: 'one/a.md', content: 'a' }))
    expect(await answer(tokensOf(asked)[0]!)).toMatchObject({ ok: true })
    expect((await as('agent:two', () => call('fs_write', { path: 'one/a.md', content: 'a' }))).outcome).toBe('approval_required')
    expect(await as('agent:one', () => call('fs_write', { path: 'one/a.md', content: 'a' }))).toMatchObject({ outcome: 'ok' })
    expect(runtime.approvals.unspent('s')).toEqual([])
  })

  it('shows check-url an unspent once in the session it names, whichever actor asked, naming that actor', async () => {
    const { runtime, answer } = await node()
    const [request] = (await runtime.approvals.ask({
      tool: 'web_fetch', sessionId: 's', actor: 'agent:one', call: { arguments: { url: 'http://localhost:3000/' }, cwd: '/workspace', description: null, effects: ['network http://localhost:3000/'], complete: true },
      asks: [{ kind: 'ask', rule: 'network_egress', subject: 'localhost:3000', reason: 'local', offeredScopes: ['once'], ...PLAIN_MARKS }],
    })).requests
    expect(await answer(request!.token)).toMatchObject({ ok: true })
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await checkUrlCommand({ argv: ['localhost:3000', '--session', 's'], runtime: async () => runtime })).toEqual({ exitCode: 0 })
    expect(out.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('unspent once approval for web_fetch of agent:one in session s')
  })

  it('writes a session grant once its resolved entry is on disk, never while its ask still waits', async () => {
    const { runtime, config, call, answer } = await node()
    const [token] = tokensOf(await call('fs_write', { path: 'one/a.md', content: 'a' }))
    const onDisk = () => {
      const ledger = JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as { pending: Array<{ request: { token: string } }>; resolved: Array<{ decision: { token: string } }> }
      return { pending: ledger.pending.some(entry => entry.request.token === token), resolved: ledger.resolved.some(entry => entry.decision.token === token) }
    }
    const seen: Array<ReturnType<typeof onDisk>> = []
    const grant = runtime.grants.grant.bind(runtime.grants)
    vi.spyOn(runtime.grants, 'grant').mockImplementation(async (input) => { seen.push(onDisk()); return grant(input) })
    expect(await answer(token!, { scope: 'session' })).toMatchObject({ ok: true })
    expect(seen).toEqual([{ pending: false, resolved: true }])
    expect(onDisk()).toEqual({ pending: false, resolved: true })
  })

  it('keeps its ask in the ledger and its grant under the workspace id', async () => {
    const { runtime, config, call, answer } = await node()
    const asked = await call('fs_write', { path: 'one/a.md', content: 'a' })
    const ledger = JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as { pending: Array<{ workspace: string }> }
    expect(ledger.pending.map(entry => entry.workspace)).toEqual([runtime.workspaceId])
    expect(config.cwd).not.toBe(runtime.workspaceId)
    expect(await answer(tokensOf(asked)[0]!, { scope: 'always' })).toMatchObject({ ok: true })
    const grants = JSON.parse(readFileSync(grantsPath(config), 'utf8')) as { grants: Array<{ workspace: string }> }
    expect(grants.grants.map(grant => grant.workspace)).toEqual([runtime.workspaceId])
  })
})

describe('a delete at the file floor', () => {
  it('offers always, and an always grant clears the next delete in that folder without asking', async () => {
    const { runtime, workspace, call, answer, folder } = await node()
    writeFileSync(join(workspace, 'one', 'a.txt'), 'a')
    writeFileSync(join(workspace, 'one', 'b.txt'), 'b')
    await runtime.grants.grant({ sessionId: 's', rule: 'write_scope', subject: folder, scope: 'session' })

    const asked = await call('fs_delete', { paths: ['one/a.txt'] }, { requestId: 'delete-a' })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `delete:${join(folder, 'one')}`, offeredScopes: ['once', 'session', 'always'] }] })
    expect(await answer(tokensOf(asked)[0]!, { scope: 'always' })).toMatchObject({ ok: true })

    expect(await call('fs_delete', { paths: ['one/a.txt'] }, { requestId: 'delete-a', tokens: tokensOf(asked) })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_delete', { paths: ['one/b.txt'] })).toMatchObject({ outcome: 'ok' })
    expect(runtime.grants.list().filter(grant => grant.subject.startsWith('delete:'))).toEqual([expect.objectContaining({ subject: `delete:${join(folder, 'one')}`, scope: 'always', sessionId: null })])
  })
})

describe('the checks an answer meets', () => {
  async function waitingAsk(path = 'one/a.md') {
    const context = await node()
    const asked = await context.call('fs_write', { path, content: 'a' })
    return { ...context, token: tokensOf(asked)[0]! }
  }

  it.each([
    ['an unknown token', (token: string) => ({ token: `${token}-other`, approved: true, scope: 'once' as const }), 'Approval token is unknown or expired'],
    ['a lasting denial of a write', (token: string) => ({ token, approved: false, scope: 'session' as const }), 'Persistent denials are supported only for sensitive files'],
    ['another subject than the ask offers', (token: string) => ({ token, approved: true, scope: 'session' as const, subject: '/elsewhere' }), 'not /elsewhere'],
  ])('refuses %s', async (_name, decision, reason) => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: decision(token), source: SOURCES.cli })).toMatchObject({ ok: false, reason: expect.stringContaining(reason) })
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([token])
  })

  it('refuses a lasting answer from a relayed source, and a host pattern on a write', async () => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.judge })).toEqual({ ok: false, code: 'assurance_too_low', reason: 'This answer is relayed, so it decides once and nothing that outlives the call' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.judge, widenTo: '*.example.com' })).toEqual({ ok: false, code: 'assurance_too_low', reason: 'This answer is relayed, so it decides once and nothing that outlives the call' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli, widenTo: '*.example.com' })).toEqual({ ok: false, code: 'scope_forbidden', reason: 'A once approval covers one call to the host that asked; widen a session or always approval instead' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli, widenTo: '*.example.com' })).toMatchObject({ ok: false, reason: expect.stringContaining('--host widens a network approval only; this one is write_scope') })
  })

  it('refuses a challenge other than the ask\'s, and a signed once past its proof deadline', async () => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli, challenge: 'f'.repeat(64) })).toEqual({ ok: false, code: 'action_mismatch', reason: 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli, consumeNotAfter: Date.now() - 1 })).toEqual({ ok: false, code: 'proof_expired', reason: 'Signed approval expired before tool admission; sign a fresh decision over the current challenge' })
  })

  it('accepts the ask\'s own challenge, signed with the workspace\'s name or without it', async () => {
    const { runtime, call } = await node()
    const tokens = [await call('fs_write', { path: 'one/a.md', content: 'a' }), await call('fs_write', { path: 'one/b.md', content: 'b' })].map(response => tokensOf(response)[0]!)
    for (const [index, workspaceName] of [false, true].entries()) {
      const challenge = runtime.approvalService.challengeListing({ workspaceName }).challenges.find(entry => entry.token === tokens[index])!.challenge!
      expect(challenge.workspaceName === undefined).toBe(!workspaceName)
      expect(await runtime.approvalService.answer({ decision: { token: tokens[index]!, approved: true, scope: 'once' }, source: SOURCES.cli, challenge: challengeBytes(challenge).digest })).toMatchObject({ ok: true })
    }
  })

  it('answers the same decision again as repeated, and refuses a different one', async () => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true, repeated: true, asked: { rule: 'write_scope' } })
    expect(await runtime.approvalService.answer({ decision: { token, approved: false, scope: 'once' }, source: SOURCES.cli })).toEqual({ ok: false, code: 'conflicting_decision', reason: 'Approval already has a different decision' })
  })

  it('refuses a scope the ask does not offer, and any approval of an ask recorded without its whole call', async () => {
    const { runtime } = await node()
    const [secret] = (await runtime.approvals.ask({ tool: 'fs_read', sessionId: 's', asks: [{ kind: 'ask', rule: 'sensitive_path', subject: '/workspace/.env', reason: 'WARNING', offeredScopes: ['once'], ...PLAIN_MARKS }], call: { arguments: {}, cwd: '/workspace', description: null, complete: true } })).requests
    expect(await runtime.approvalService.answer({ decision: { token: secret!.token, approved: true, scope: 'session' }, source: SOURCES.cli })).toEqual({ ok: false, code: 'scope_not_offered', reason: 'Scope session is not offered for this approval' })
    const [bare] = (await runtime.approvals.ask({ tool: 'fs_write', sessionId: 's', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'], ...PLAIN_MARKS }] })).requests
    expect(await runtime.approvalService.answer({ decision: { token: bare!.token, approved: true, scope: 'once' }, source: SOURCES.cli })).toEqual({ ok: false, code: 'incomplete_action', reason: `This ask was ${RECORDED_BEFORE_NOTE}` })
    expect(await runtime.approvalService.answer({ decision: { token: bare!.token, approved: false, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
  })
})

describe('the setup face', () => {
  it('denies through an unsigned decision and never approves through one', async () => {
    const { runtime, call } = await node()
    const [first, second] = [await call('fs_write', { path: 'one/a.md', content: 'a' }), await call('fs_write', { path: 'one/b.md', content: 'b' })].map(response => tokensOf(response)[0]!)
    expect(await runtime.approvalService.decide({ source: 'sealed', body: { token: first, approved: true, scope: 'once' } })).toEqual({
      status: 'refused', step: 'decision', decision: { token: first, approved: true, scope: 'once' },
      error: { code: 'capability_exceeded', message: 'Approval requires an enrolled device key: review and confirm with buckle client approve', retryable: false },
    })
    expect(await runtime.approvalService.decide({ source: 'sealed', body: { token: second, approved: false, scope: 'once' } })).toMatchObject({ status: 'applied', decision: { token: second, approved: false, scope: 'once' }, asked: { rule: 'write_scope' } })
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([first])
  })

  it('keeps an unsigned denial of a secret file for the session, so the file stays denied in it', async () => {
    const { runtime, call, workspace } = await node()
    writeFileSync(join(workspace, '.env'), 'TOKEN=fixture\n')
    const [token] = tokensOf(await call('fs_read', { path: '.env' }))
    expect(await runtime.approvalService.decide({ source: 'sealed', body: { token, approved: false, scope: 'session' } })).toMatchObject({ status: 'applied', decision: { token, approved: false, scope: 'session' }, asked: { rule: 'sensitive_path' } })
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'sensitive_path', scope: 'session', sessionId: 's', denied: true })])
    expect(await call('fs_read', { path: '.env' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  })

  it('withdraws a call by token, naming the asks withdrawn and the onces dropped', async () => {
    const { runtime, call, answer } = await node()
    const asked = await call('fs_write_batch', { files: [{ path: 'one/a.md', content: 'a' }, { path: 'b.md', content: 'b' }] })
    const [first, second] = tokensOf(asked)
    expect(await answer(first!)).toMatchObject({ ok: true })
    expect(await runtime.approvalService.withdrawCall({ token: second! })).toEqual({ withdrawn: [second], dropped: [first], selector: { token: second } })
    expect(runtime.approvals.unspent('s')).toEqual([])
  })
})

describe('the HTTP MCP face', () => {
  it('ignores the form answers a call carries, since the agent token reaches it: the ask waits, and nothing is spent or granted', async () => {
    const { runtime, workspace, tool, waiting } = await mcpNode({ trusted: false })
    const write = tool('fs_write')
    const args = { path: 'one/a.md', content: 'a' }
    expect(await write(args)).toMatchObject({ structuredContent: { outcome: 'approval_required' } })
    const [token] = waiting()
    for (const scope of ['once', 'session'] as const) {
      expect(await write(args, accepted(token!, { approve: true, scope }))).toMatchObject({ structuredContent: { outcome: 'approval_required' } })
      expect(waiting()).toEqual([token])
      expect(runtime.approvals.unspent('mcp')).toEqual([])
      expect(runtime.grants.list()).toEqual([])
    }
    expect(existsSync(join(workspace, 'one', 'a.md'))).toBe(false)
  })
})

describe('a stdio MCP form answer', () => {
  it('counts as the person\'s: a session answer on a first write remembers its folder, and is recorded as the forms\' decision', async () => {
    const { runtime, workspace, folder, tool, waiting } = await mcpNode({ trusted: true })
    const write = tool('fs_write')
    await write({ path: 'one/a.md', content: 'a' })
    const [token] = waiting()
    expect(await write({ path: 'one/a.md', content: 'a' }, accepted(token!, { approve: true, scope: 'session' }))).not.toHaveProperty('isError')
    expect(await write({ path: 'one/b.md', content: 'b' })).not.toHaveProperty('isError')

    expect(waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'one', 'b.md'), 'utf8')).toBe('b')
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', subject: join(folder, 'one'), scope: 'session', sessionId: 'mcp' })])
    const entries = await auditEntries(runtime.actions, 50)
    // By call, not across the file: a run call's result is queued with the log service and can land after the next call's attempt,
    // which is awaited. Within a call the attempt is written before the tool runs, so its result always follows it.
    const writeCalls = Object.values(Object.groupBy(entries.filter(entry => entry.tool === 'fs_write'), entry => entry.auditId ?? 'no audit id'))
    expect(writeCalls.map(call => call!.map(entry => entry.event))).toEqual(Array.from({ length: 3 }, () => ['attempt', 'result']))
    expect(entries.filter(entry => entry.tool === 'approval_decision').map(entry => [entry.event, entry.outcome, entry.args])).toEqual([
      ['attempt', 'started', expect.objectContaining({ token, outcome: 'approve', scope: 'session', source: SOURCES.forms })],
      ['result', 'ok', expect.objectContaining({ token, source: SOURCES.forms, assurance: 'local', save: 'saved' })],
    ])
  })

  it('approves a delete at the file floor, and its always answer lands an always grant that clears the next delete there', async () => {
    const { runtime, workspace, folder, tool, waiting } = await mcpNode({ trusted: true })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(workspace, 'one', name), name)
    await runtime.grants.grant({ sessionId: 'mcp', rule: 'write_scope', subject: folder, scope: 'session' })
    const remove = tool('fs_delete')
    const answered = async (path: string, scope: 'once' | 'always') => {
      await remove({ paths: [path] })
      expect(runtime.approvalService.waiting().map(ask => [ask.request.subject, ask.floor, ask.destructive])).toEqual([[`delete:${join(folder, 'one')}`, true, true]])
      return remove({ paths: [path] }, accepted(waiting()[0]!, { approve: true, scope }))
    }
    expect(await answered('one/a.txt', 'once')).not.toHaveProperty('isError')
    expect(await answered('one/b.txt', 'always')).not.toHaveProperty('isError')
    expect(await remove({ paths: ['one/c.txt'] })).not.toHaveProperty('isError')

    expect(['a.txt', 'b.txt', 'c.txt'].map(name => existsSync(join(workspace, 'one', name)))).toEqual([false, false, false])
    expect(runtime.grants.list().filter(grant => grant.subject.startsWith('delete:'))).toEqual([expect.objectContaining({ subject: `delete:${join(folder, 'one')}`, scope: 'always', sessionId: null })])
  })
})

describe('an answer while the action log cannot be written', () => {
  /** The workspace's log becomes a directory: every write fails, its own decision records included. */
  const breakLog = (config: BuckleConfig) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    rmSync(actionsPath(config), { force: true })
    mkdirSync(actionsPath(config))
  }

  it('still resolves the ask from the serve terminal', async () => {
    let broken = () => {}
    const asker: Interaction = { hold: 'grace', requestCli: async (request) => { broken(); return { status: 'answered', requestId: request.id, answer: { choice: 'session' } } } }
    const { runtime, config, call, folder } = await node({ interaction: asker })
    broken = () => breakLog(config)
    const answers = vi.spyOn(runtime.approvalService, 'answer')
    await call('fs_write', { path: 'one/a.md', content: 'a' })

    expect(answers).toHaveBeenCalledTimes(1)
    expect(await answers.mock.results[0]!.value).toMatchObject({ ok: true })
    expect(runtime.approvalService.pending()).toEqual([])
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', subject: join(folder, 'one'), scope: 'session' })])
  })

  it('still resolves the ask from a stdio form, while the call that carried the answer does not run', async () => {
    const { runtime, config, workspace, folder, tool, waiting } = await mcpNode({ trusted: true })
    const write = tool('fs_write')
    await write({ path: 'one/a.md', content: 'a' })
    const [token] = waiting()
    breakLog(config)
    const answers = vi.spyOn(runtime.approvalService, 'answer')

    expect(await write({ path: 'one/a.md', content: 'a' }, accepted(token!, { approve: true, scope: 'session' }))).toMatchObject({ isError: true })
    expect(await answers.mock.results[0]!.value).toMatchObject({ ok: true })
    expect(waiting()).toEqual([])
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', subject: join(folder, 'one'), scope: 'session', sessionId: 'mcp' })])
    expect(existsSync(join(workspace, 'one', 'a.md'))).toBe(false)
  })
})

describe('the dangerously-allow switch', () => {
  it('lifts the floor-marked asks the real rules make on, a delete\'s and a recursive delete command\'s, and leaves them to a person at safe', async () => {
    const { runtime, workspace, call } = await node({ shell: true })
    writeFileSync(join(workspace, 'one', 'a.txt'), 'a')
    mkdirSync(join(workspace, 'build'))
    const calls: Array<[string, JsonObject]> = [['fs_delete', { paths: ['one/a.txt'] }], ['shell_exec', { command: 'rm', args: ['-rf', 'build'] }]]
    for (const [tool, args] of calls) expect(await call(tool, args)).toMatchObject({ outcome: 'approval_required' })
    const floor = runtime.approvalService.waiting().filter(ask => ask.floor && ask.destructive).map(ask => ask.request.rule)
    expect(new Set(floor)).toEqual(new Set(['write_scope', 'destructive_command']))

    await runtime.policy.setDangerouslyAllow('safe')
    for (const [tool, args] of calls) expect(await call(tool, args)).toMatchObject({ outcome: 'approval_required' })
    expect([existsSync(join(workspace, 'one', 'a.txt')), existsSync(join(workspace, 'build'))]).toEqual([true, true])

    await runtime.policy.setDangerouslyAllow('on')
    for (const [tool, args] of calls) expect(await call(tool, args)).toMatchObject({ outcome: 'ok' })
    expect([existsSync(join(workspace, 'one', 'a.txt')), existsSync(join(workspace, 'build'))]).toEqual([false, false])
  })

  it('lifts floor asks on, a delete\'s and a command\'s, keeps them at safe, and leaves a restore to a person in both', () => {
    const asks = [
      { kind: 'ask' as const, rule: 'destructive_command' as const, subject: 'rm -rf build', reason: 'floor', offeredScopes: ['once' as const, 'session' as const], cause: 'floor' as const, ...commandMarks('floor') },
      { kind: 'ask' as const, rule: 'write_scope' as const, subject: 'delete:/work/project/src', reason: 'floor', offeredScopes: ['once' as const, 'session' as const, 'always' as const], ...FILE_FLOOR_MARKS },
      { kind: 'ask' as const, rule: 'write_scope' as const, subject: 'restore:change-1', reason: 'floor', offeredScopes: ['once' as const], ...FILE_FLOOR_MARKS },
    ]
    const asking: PermissionEngine = { evaluate: () => ({ kind: 'ask', asks }) }
    const evaluate = (engine: PermissionEngine) => engine.evaluate({ tool: 'shell_exec', effects: [], grants: { subjectsFor: () => [] } })
    expect(evaluate(withDangerouslyAllow(asking, { mode: () => 'on', root: () => '/work/project' }))).toEqual({ kind: 'ask', asks: [asks[2]] })
    expect(evaluate(withDangerouslyAllow(asking, { mode: () => 'safe', root: () => '/work/project' }))).toEqual({ kind: 'ask', asks })
    const without: PermissionEngine = { evaluate: () => ({ kind: 'ask', asks: asks.slice(0, 2) }) }
    expect(evaluate(withDangerouslyAllow(without, { mode: () => 'on', root: () => '/work/project' }))).toEqual({ kind: 'allow', allowedBy: ['dangerously_allow:on:destructive_command:rm -rf build', 'dangerously_allow:on:write_scope:delete:/work/project/src'] })
  })
})
