import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import { NO_INTERACTION } from '../common/services/approvals/interaction.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { initializeCommon } from '../common/runtime/initialize.js'
import { createMcpServer } from '../mcp/server.js'
import { stdioCallScope } from '../mcp/stdio.js'
import type { ServerContext } from '@modelcontextprotocol/server'
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
    const [approval] = (await registry.ask({ tool: 'fs_write', sessionId: 'chat-1', asks: [ask('/outside/a.md')] })).requests
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
    const [other] = (await registry.ask({ tool: 'fs_write', sessionId: 'chat-2', asks: [ask('/outside/other.md')] })).requests
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
    const [victim] = (await registry.ask({ tool: 'fs_write', sessionId: 'chat-2', asks: [ask('/outside/victim.md')] })).requests
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
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace) })
    const none = { wait: { mode: 'none' } } as const

    const [first, again] = await Promise.all([service.request(call(none)), service.request(call(none))])

    expect(again.approvals.map(request => request.token)).toEqual(first.approvals.map(request => request.token))
    expect(registry.pending()).toHaveLength(1)
    await expect(service.request(call({ ...none, asks: [ask('/outside/other.md')] }))).rejects.toBeInstanceOf(ApprovalConflictError)
    // Another session reusing the id is not a join: it gets asks of its own.
    expect((await service.request(call({ ...none, sessionId: 'chat-9' }))).approvals[0]!.token).not.toBe(first.approvals[0]!.token)
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

  it('cancels the asks when the caller cancels inside the wait, but not once a joined caller carries them', async () => {
    const { registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace) })
    const leaving = new AbortController()
    const first = service.request(call({ signal: leaving.signal, isCancel: () => true }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    const joined = service.request(call())

    // The newer caller took the wait over, so the first reports back without running.
    expect(await first).toMatchObject({ settled: false, superseded: true })
    leaving.abort()
    expect(registry.pending()).toHaveLength(1)

    const alone = new AbortController()
    const last = service.request(call({ requestId: 'request-2', asks: [ask('/outside/c.md')], signal: alone.signal, isCancel: () => true }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(2))
    alone.abort()
    await expect(last).rejects.toThrow()
    expect(registry.pending()).toHaveLength(1)
    await service.close()
    expect(await joined).toMatchObject({ settled: false })
  })

  it('keeps the asks pending when the caller\'s transport drops inside the wait, and a re-send with the same requestId joins them (owner decision D4)', async () => {
    const { registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace) })
    const dropped = new AbortController()
    const first = service.request(call({ signal: dropped.signal }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    const [token] = registry.pending().map(request => request.token)
    dropped.abort()
    await expect(first).rejects.toThrow()
    expect(registry.pending().map(request => request.token)).toEqual([token])

    const resent = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    await service.answer({ decision: { token: token!, approved: true, scope: 'once' }, authority: 'admin' })
    expect(await resent).toMatchObject({ settled: true, approvals: [expect.objectContaining({ token })] })
    await service.close()
  })

  it('reads only an explicit cancel as one: without a way to tell, an abort is a dropped transport', async () => {
    const { registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: fixedInteraction(headlessGrace) })
    const dropped = new AbortController()
    const waiting = service.request(call({ signal: dropped.signal, isCancel: reason => reason === 'client cancelled' }))
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    dropped.abort(new Error('Connection closed'))
    await expect(waiting).rejects.toThrow('Connection closed')
    expect(registry.pending()).toHaveLength(1)
    await service.close()
  })

  it('settles every open wait as still pending on close, keeping the asks', async () => {
    const { registry } = queue()
    let withdrawn = false
    const requestCli: RequestCli = (request, options) => new Promise(resolve => options?.signal?.addEventListener('abort', () => { withdrawn = true; resolve({ status: 'cancelled', requestId: request.id, reason: 'closed' }) }))
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: null, interaction: fixedInteraction({ requestCli, hold: 'grace' }) })
    const waiting = service.request(call())
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))

    await service.close()

    expect(await waiting).toMatchObject({ settled: false })
    expect(registry.pending()).toHaveLength(1)
    expect(withdrawn).toBe(true)
  })
})

describe('how long a gated call is held', () => {
  it("takes the caller's hint over the entry point's own hold, shorter or longer (owner ruling of 2026-09-28)", () => {
    expect(holdFor({ hold: 'grace', graceMs: 15_000 })).toBe(15_000)
    expect(holdFor({ hold: 'grace', graceMs: null })).toBeNull()
    expect(holdFor({ hold: 'grace', graceMs: 15_000, hint: { mode: 'finite', ms: 50 } })).toBe(50)
    expect(holdFor({ hold: 'grace', graceMs: 50, hint: { mode: 'finite', ms: 60_000 } })).toBe(60_000)
    expect(holdFor({ hold: 'grace', graceMs: null, hint: { mode: 'finite', ms: 60_000 } })).toBe(60_000)
    expect(holdFor({ hold: 'grace', graceMs: null, hint: { mode: 'none' } })).toBe(0)
    // A CLI command holds while its terminal asks; a hint sets that too.
    expect(holdFor({ hold: 'prompt', graceMs: 15_000 })).toBeNull()
    expect(holdFor({ hold: 'prompt', graceMs: 15_000, hint: { mode: 'finite', ms: 50 } })).toBe(50)
  })
})

describe('an interaction bound to nothing', () => {
  it('reaches nobody and holds no call, whatever the node\'s own wait, and leaves the ask pending', async () => {
    const { registry } = queue()
    const service = createApprovalService({ registry, workspaceId: 'default', graceMs: 60_000, interaction: async () => undefined })

    const started = performance.now()
    expect(await service.request(call())).toMatchObject({ settled: false })
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(registry.pending()).toHaveLength(1)
  })
})

describe('the interaction each HTTP request binds', () => {
  // /v1/invoke and HTTP MCP: test/http/approval-http.test.ts, on the harness.
  it('gives each stdio MCP tool call an operation of its own, with main\'s requester injected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-stdio-interaction-'))
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '200' })
    const common = initializeCommon({ config, role: 'mcp' })
    await common.start()
    const questions: Array<{ actor?: string; sessionId?: string }> = []
    const requestCli: RequestCli = async request => { questions.push({ actor: request.actor, sessionId: request.sessionId }); return { status: 'unavailable', requestId: request.id, reason: 'no_consumer' } }
    common.bindRequester(requestCli)
    const server = createMcpServer({ runtime: await common.services.getWorkspaceRuntime(), serverName: 'stdio-test', version: '0', trustedApprovalResponses: true, callScope: stdioCallScope(common) })
    const tools = (server as unknown as { _registeredTools: Record<string, { handler(args: unknown, context: ServerContext): Promise<{ isError?: boolean }> }> })._registeredTools

    const result = await tools.fs_write!.handler({ path: 'a.md', content: 'x' }, { sessionId: 'stdio-session', mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext)

    expect(result.isError).toBe(true)
    expect(questions).toEqual([{ actor: 'mcp-stdio', sessionId: 'stdio-session' }])
    await common.owner.close()
  })
})

/** A stand-in for the approval webhook, keeping every body it receives. */
async function captureWebhook() {
  const bodies: Array<{ approvals?: Array<{ token: string; subject: string }>; notices?: Array<{ token: string; event: string; scope?: string; reason?: string }> }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => { bodies.push(JSON.parse(body)); response.writeHead(202).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/approvals`,
    announced: () => bodies.flatMap(body => body.approvals ?? []),
    notices: () => bodies.flatMap(body => body.notices ?? []),
    bodies,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

describe('announcing an ask to the approval webhook', () => {
  it('announces each new ask from every entry point once, including calls that do not wait', async () => {
    const webhook = await captureWebhook()
    try {
      const root = mkdtempSync(join(tmpdir(), 'buckle-announce-'))
      for (const directory of ['one', 'two']) mkdirSync(join(root, directory))
      const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: `${root}-state`, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_WEBHOOK: webhook.url })
      // No interaction bound: a CLI command without a terminal, which reports back at once.
      const runtime = await createRuntime({ config })
      const write = (requestId: string, path: string, extra = {}) => runtime.invoke({ sessionId: 'chat-1', request: { requestId, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [] }, ...extra })

      expect(await write('cli-call', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
      // An MCP host that elicits asks with the hint none, and is announced all the same.
      expect(await write('elicited-call', 'two/b.md', { approvalWait: { mode: 'none' } })).toMatchObject({ outcome: 'approval_required' })
      // A re-send joining the first ask is not announced again.
      expect(await write('cli-call', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
      await runtime.approvalService.close()

      expect(webhook.bodies.filter(body => body.approvals).map(body => body.approvals!.map(approval => approval.subject))).toEqual([[join(root, 'one')], [join(root, 'two')]])
      expect(webhook.bodies[0]).toMatchObject({ serverId: config.serverId, workspaceId: 'default', approvals: [{ tool: 'fs_write', approveCommand: expect.stringContaining('buckle approve ') }] })
      await runtime.history.close()
    } finally {
      await webhook.close()
    }
  })
})
