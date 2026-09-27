import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookRequestCli, InteractionErrorCode, type RequestCli } from '@5straps/runtime'
import type { PermissionRuleId } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { setupCli } from '../cli/setup.js'
import { createTerminalConsumer } from '../cli/terminal-consumer.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { loadConfig } from '../common/runtime/config.js'
import { ApprovalConflictError, createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, holdFor, questionFor, type ApprovalAskInput } from '../common/services/approvals/approval-service.js'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { initializeCommon } from '../common/runtime/initialize.js'
import { createHttpApp } from '../server/hono/http-app.js'
import { operationScopes, type ScopeEnv } from '../server/hono/operation-scope.js'
import { Hono } from 'hono'
import { fixedInteraction, headlessGrace } from './support/interaction.js'

function queue(root = mkdtempSync(join(tmpdir(), 'buckle-approval-service-'))) {
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  return { root, grants, registry: createApprovalRegistry(grants, join(root, 'approvals.json'), root, 15_000) }
}

function ask(subject: string, rule: PermissionRuleId = 'write_scope') {
  return { kind: 'ask' as const, rule, subject, reason: 'outside the workspace', offeredScopes: ['once' as const, 'session' as const] }
}

function call(overrides: Partial<ApprovalAskInput> = {}): ApprovalAskInput {
  return { sessionId: 'chat-1', requestId: 'request-1', tool: 'fs_write', asks: [ask('/outside/a.md')], ...overrides }
}

/** A terminal that answers its questions in order with the given choices, then leaves the rest on screen. */
function scriptedTerminal(choices: string[]): { requestCli: RequestCli; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    requestCli: async (request, options) => {
      asked.push(request.id)
      const choice = choices[asked.length - 1]
      if (choice !== undefined) return { status: 'answered', requestId: request.id, answer: { choice } }
      return new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', requestId: request.id, reason: 'withdrawn' }), { once: true }))
    },
  }
}

describe('the approval service, the single answerer', () => {
  it('headless: issues the ask, returns its pending id at once, and approves nothing', async () => {
    const { registry, grants } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 15_000, interaction: fixedInteraction(NO_INTERACTION) })

    const result = await service.request(call())

    expect(result.settled).toBe(false)
    expect(registry.pending().map(request => request.token)).toEqual(result.approvals.map(request => request.token))
    expect(grants.list()).toEqual([])
    expect(registry.unspent('chat-1')).toEqual([])
  })

  it('headless: the requester answers unavailable with the pending id and the command that answers it', async () => {
    const { registry } = queue()
    const [approval] = await registry.issue({ tool: 'fs_write', sessionId: 'chat-1', asks: [ask('/outside/a.md')] })
    const cli = setupCli({ terminal: null })

    const outcome = await cli.requestCli(questionFor({ approval: approval!, workspaceId: 'default', context: { correlationId: 'c1', sessionId: 'chat-1' } }))

    expect(outcome).toEqual({ status: 'unavailable', requestId: `approval:default:${approval!.token}`, reason: 'no_consumer',
      pending: { id: `approval:default:${approval!.token}`, instructions: `buckle approve ${approval!.token} --scope session` } })
    expect(registry.pending()).toHaveLength(1)
  })

  it('refuses a second terminal: one interactive consumer per process', () => {
    const cli = setupCli({ terminal: null })
    cli.slot.attach(createTerminalConsumer())
    expect(() => cli.slot.attach(createTerminalConsumer())).toThrow(expect.objectContaining({ code: InteractionErrorCode.consumerAttached }))
  })

  it('records each terminal answer for the token its question asked about', async () => {
    const { registry, grants } = queue()
    const terminal = scriptedTerminal(['once', 'session'])
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 5_000, interaction: fixedInteraction({ hold: 'grace', requestCli: terminal.requestCli }) })

    const result = await service.request(call({ asks: [ask('/outside/a.md'), ask('/outside/b.md')] }))

    const [a, b] = result.approvals
    expect(result.settled).toBe(true)
    expect(terminal.asked).toEqual([`approval:default:${a!.token}`, `approval:default:${b!.token}`])
    expect(registry.unspent('chat-1').map(entry => entry.subject.subject)).toEqual(['/outside/a.md'])
    expect(grants.list().map(grant => [grant.subject, grant.scope])).toEqual([['/outside/b.md', 'session']])
  })

  it('lets no answer resolve another token than its question\'s: an unknown choice denies the asked one once', async () => {
    const { registry } = queue()
    const [other] = await registry.issue({ tool: 'fs_write', sessionId: 'chat-2', asks: [ask('/outside/other.md')] })
    const terminal = scriptedTerminal([other!.token])
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 5_000, interaction: fixedInteraction({ hold: 'grace', requestCli: terminal.requestCli }) })

    const result = await service.request(call({ asks: [ask('/outside/a.md'), ask('/outside/b.md')] }))

    const [a, b] = result.approvals
    // A denial settles the call and ends its questions; the second was never asked.
    expect(result.settled).toBe(true)
    expect(terminal.asked).toEqual([`approval:default:${a!.token}`])
    expect(registry.wasDenied([a!.token])).toBe(true)
    expect(registry.wasDenied([b!.token, other!.token])).toBe(false)
    expect(registry.pending().map(request => request.token)).toEqual(expect.arrayContaining([b!.token, other!.token]))
  })

  it('ignores a cli:call listener that answers another question than the one it was given', async () => {
    const { registry } = queue()
    const [victim] = await registry.issue({ tool: 'fs_write', sessionId: 'chat-2', asks: [ask('/outside/victim.md')] })
    const requestCli = createHookRequestCli({ hasListener: () => true, dispatch: async (_request, respond) => {
      respond({ status: 'answered', requestId: `approval:default:${victim!.token}`, answer: { choice: 'session' } })
    } })
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 200, interaction: fixedInteraction({ hold: 'grace', requestCli }) })

    const result = await service.request(call())

    expect(result.settled).toBe(false)
    expect(registry.pending().map(request => request.token)).toEqual(expect.arrayContaining([victim!.token, result.approvals[0]!.token]))
  })

  it('joins a re-sent call with the same requestId, session and actor to the same asks, and refuses different ones', async () => {
    const { registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 0, interaction: fixedInteraction(headlessGrace) })

    const [first, again] = await Promise.all([service.request(call()), service.request(call())])

    expect(again.approvals.map(request => request.token)).toEqual(first.approvals.map(request => request.token))
    expect(registry.pending()).toHaveLength(1)
    await expect(service.request(call({ asks: [ask('/outside/other.md')] }))).rejects.toBeInstanceOf(ApprovalConflictError)
    // Another session reusing the id is not a join: it gets asks of its own.
    expect((await service.request(call({ sessionId: 'chat-9' }))).approvals[0]!.token).not.toBe(first.approvals[0]!.token)
  })

  it('answers a conflicting re-send over HTTP with 409, and a same re-send with the same tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-approval-join-'))
    // A write asks for its directory, so the conflicting call writes in another one.
    mkdirSync(join(root, 'sub'))
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(`${root}-state`), BUCKLE_AUTH_TOKEN: 'join-agent-token-fixture', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const runtime = await createRuntime({ config })
    const app = createHttpApp({ config, runtime, authToken: config.authToken })
    const invoke = (path: string) => app.request('/v1/invoke', { method: 'POST', headers: { authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'rings-invocation-1', tool: 'fs_write', args: { path, content: 'x' }, context: { sessionId: 'chat-1' } }) })

    const first = await (await invoke('a.md')).json() as { outcome: string; approvals: Array<{ token: string }> }
    const again = await (await invoke('a.md')).json() as { approvals: Array<{ token: string }> }
    const conflict = await invoke('sub/b.md')

    expect(first.outcome).toBe('approval_required')
    expect(again.approvals.map(request => request.token)).toEqual(first.approvals.map(request => request.token))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ outcome: 'error', error: { code: 'APPROVAL_CONFLICT', retryable: false } })
    await runtime.history.close()
  })

  it('wakes the waiter at once for an answer given in this process', async () => {
    const { registry } = queue()
    // A poll this slow proves the wake-up does not come from polling.
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace), pollMs: 60_000 })
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    const started = performance.now()

    expect((await service.answer({ decision: { token: registry.pending()[0]!.token, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)

    expect(await waiting).toMatchObject({ settled: true })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('notices an answer another process wrote within the poll interval', async () => {
    const { root, registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace), pollMs: 50 })
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))

    // A second registry over the same files stands in for `buckle approve` in another process.
    const elsewhere = queue(root).registry
    expect((await elsewhere.resolve({ token: elsewhere.pending()[0]!.token, approved: true, scope: 'session' })).ok).toBe(true)

    expect(await waiting).toMatchObject({ settled: true })
  })

  it('cancels the asks when the caller leaves inside the wait, but not while a joined caller still waits', async () => {
    const { registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace) })
    const leaving = new AbortController()
    const first = service.request(call({ signal: leaving.signal }))
    const joined = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))

    leaving.abort()
    await expect(first).rejects.toThrow()
    expect(registry.pending()).toHaveLength(1)

    const alone = new AbortController()
    const last = service.request(call({ requestId: 'request-2', asks: [ask('/outside/c.md')], signal: alone.signal }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(2))
    alone.abort()
    await expect(last).rejects.toThrow()
    expect(registry.pending()).toHaveLength(1)
    service.close()
    expect(await joined).toMatchObject({ settled: false })
  })

  it('settles every open wait as still pending on close, keeping the asks', async () => {
    const { registry } = queue()
    let withdrawn = false
    const requestCli: RequestCli = (request, options) => new Promise(resolve => options?.signal?.addEventListener('abort', () => { withdrawn = true; resolve({ status: 'cancelled', requestId: request.id, reason: 'closed' }) }))
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: null, interaction: fixedInteraction({ requestCli, hold: 'grace' }) })
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))

    service.close()

    expect(await waiting).toMatchObject({ settled: false })
    expect(registry.pending()).toHaveLength(1)
    await vi.waitFor(() => expect(withdrawn).toBe(true))
  })
})

describe('how long a gated call is held', () => {
  it("takes the entry point's own hold, which a caller's hint only shortens", () => {
    expect(holdFor({ hold: 'grace', graceMs: 15_000 })).toBe(15_000)
    expect(holdFor({ hold: 'grace', graceMs: 15_000, hint: { mode: 'finite', ms: 50 } })).toBe(50)
    expect(holdFor({ hold: 'grace', graceMs: 50, hint: { mode: 'finite', ms: 60_000 } })).toBe(50)
    expect(holdFor({ hold: 'grace', graceMs: null, hint: { mode: 'finite', ms: 60_000 } })).toBe(60_000)
    expect(holdFor({ hold: 'grace', graceMs: null, hint: { mode: 'none' } })).toBe(0)
    // A CLI command holds while its terminal asks; the hint bounds that too.
    expect(holdFor({ hold: 'prompt', graceMs: 15_000 })).toBeNull()
    expect(holdFor({ hold: 'prompt', graceMs: 15_000, hint: { mode: 'finite', ms: 50 } })).toBe(50)
  })
})

describe('an interaction bound to nothing', () => {
  it('asks nobody and holds no call', async () => {
    const { registry } = queue()
    const requestCli = vi.fn<RequestCli>(NO_INTERACTION.requestCli)
    const interaction: Interaction = { requestCli, hold: 'grace' }
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 0, interaction: fixedInteraction(interaction) })

    expect(await service.request(call())).toMatchObject({ settled: false })
    expect(requestCli).not.toHaveBeenCalled()
  })
})

describe('the interaction each HTTP request binds', () => {
  it('reaches the approval service from /v1/invoke and from an MCP tool call alike', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-http-interaction-'))
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'interaction-agent-token', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '300' })
    const common = initializeCommon({ config, role: 'server' })
    await common.start()
    const asked: string[] = []
    const requestCli: RequestCli = async request => { asked.push(String(request.action.details?.tool)); return { status: 'unavailable', requestId: request.id, reason: 'no_consumer' } }
    // As serve mounts it: one operation scope per request, with the HTTP interaction bound.
    const app = new Hono<ScopeEnv>()
    app.use('*', operationScopes(common, { requestCli, hold: 'grace' }))
    app.route('/', createHttpApp({ config, runtime: await common.services.getWorkspaceRuntime(), authToken: config.authToken, workspaces: await common.services.getWorkspaces() }))
    const headers = { authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json' }

    const started = performance.now()
    const invoked = await app.request('/v1/invoke', { method: 'POST', headers, body: JSON.stringify({ requestId: 'bound-1', tool: 'fs_write', args: { path: 'a.md', content: 'x' } }) })
    expect(await invoked.json()).toMatchObject({ outcome: 'approval_required' })
    // Held for the grace period, as a bound HTTP call is; an unbound one reports back at once.
    expect(performance.now() - started).toBeGreaterThanOrEqual(290)

    const mcp = await app.request('/mcp', { method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'fs_write' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_write', arguments: { path: 'b.md', content: 'y' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) })
    expect(await mcp.text()).toContain('This call needs approval')
    expect(asked).toEqual(['fs_write', 'fs_write'])
    await common.owner.close()
  })
})
